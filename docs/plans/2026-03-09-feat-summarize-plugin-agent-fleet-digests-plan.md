---
title: "feat: Summarize Plugin — Daily/Weekly Agent Fleet Digests"
type: feat
date: 2026-03-09
brainstorm: docs/brainstorms/2026-03-09-summarize-plugin-brainstorm.md
---

# feat: Summarize Plugin — Daily/Weekly Agent Fleet Digests

## Overview

A Paperclip plugin that generates daily and weekly digest reports of agent fleet activity for team leads. Combines event accumulation with SDK data pulls to produce comprehensive digests covering fleet health, task throughput, cost spend, anomaly detection, and per-agent breakdowns. Delivers via in-app dashboard widget and optional webhook.

This is the first plugin to combine scheduled jobs + event accumulation + domain data reads + dashboard widget — a showcase of the SDK's full capability surface.

## Problem Statement / Motivation

Existing notifier plugins (Discord, Slack, Webhook, Email) fire on individual events. Team leads managing agent fleets have no aggregated view of daily/weekly activity — they must mentally track runs, failures, costs, and anomalies across event-by-event notifications. A digest plugin fills this gap by computing summaries, detecting anomalies against historical baselines, and delivering a single actionable report.

## Proposed Solution

A hybrid event-accumulation + scheduled-pull architecture:

1. **Event accumulators** subscribe to system events and increment counters in `ctx.state`
2. **Scheduled jobs** (daily + weekly) pull live snapshots from SDK clients and merge with accumulated counters
3. **Anomaly detector** compares current metrics to 7-day rolling average
4. **Dashboard widget** via `ctx.data.register` serves the latest digest for in-app display
5. **Webhook delivery** via `ctx.http.fetch` sends the digest to a configured endpoint

### Prerequisites — SDK Capability Extensions

Before building the plugin, create a **separate PR** for `costs.read` and `activity.read` SDK capabilities following the established 6-layer pattern. Keep this separate from PR #403 (agents.pause/resume) — different concerns deserve different PRs. PR #403 is agent lifecycle management; data-access capabilities are a distinct surface area.

## Technical Approach

### Architecture

```
                         ┌──────────────────────┐
  System Events ────────►│  Event Accumulators   │──── ctx.state (counters per company/day)
  (agent.run.*, etc.)    └──────────────────────┘
                                    │
                                    ▼
  ┌──────────────────┐    ┌──────────────────────┐    ┌──────────────┐
  │  SDK Data Pulls  │───►│   Digest Generator   │───►│ ctx.state    │
  │  (agents, issues, │    │   (scheduled job)     │    │ (latest      │
  │   costs)          │    └──────────────────────┘    │  digest)     │
  └──────────────────┘              │                  └──────┬───────┘
                                    │                         │
                              ┌─────┴─────┐           ┌──────┴───────┐
                              │  Webhook   │           │  Dashboard   │
                              │  Delivery  │           │  Widget      │
                              └───────────┘           └──────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Schedule mechanism** | Hourly cron + config-time check | Job cron is static in manifest. Handler checks `config.dailyHour` to decide whether to run. Max 59-minute slop, but simple and requires no host changes. |
| **Concurrency** | Previous-day accumulation | Job reads counters for the *previous* period, not the current one. Event handlers write to the *current* day key. Avoids read-write races entirely. |
| **Webhook secret** | Secret contains the URL | Matches existing Slack/Discord/Webhook notifier patterns. Optional HMAC signing via separate `signingSecretRef`. |
| **Company filtering** | Active companies only | Skip paused/archived companies via `ctx.companies.list()` + status filter. |
| **First-run behavior** | Partial average with disclaimer | Use available days for rolling average. Include `historicalDays: N` in digest so consumers know confidence level. |
| **State retention** | 30 days | Cleanup old keys during weekly digest job. Prevents unbounded state growth. |
| **Idempotency** | State key per digest period | `digest-daily-{companyId}-YYYY-MM-DD` prevents duplicate generation. Second run is a no-op for webhook but refreshes widget data. |
| **Partial SDK failures** | Graceful degradation | Catch errors per-section, include available data with `"unavailable"` marker. Don't throw (job succeeds). Log warnings. |

### Digest Payload Schema

```typescript
// packages/plugins/examples/plugin-summarize-example/src/types.ts

export interface DigestPayload {
  type: "daily" | "weekly";
  companyId: string;
  companyName: string;
  periodStart: string; // ISO 8601
  periodEnd: string;   // ISO 8601
  generatedAt: string; // ISO 8601
  historicalDays: number; // How many days of baseline data exist (0-7+)

  fleet: {
    agents: { active: number; running: number; paused: number; error: number; total: number };
    runs: { started: number; completed: number; failed: number; cancelled: number };
    issues: { created: number; resolved: number; open: number; inProgress: number };
    approvals: { created: number; decided: number; pending: number };
  };

  costs: {
    periodSpendCents: number;
    monthSpendCents: number;
    monthBudgetCents: number;
    utilizationPercent: number;
  } | null; // null if costs.read unavailable

  anomalies: AnomalyFlag[];

  agentBreakdown: AgentDigestRow[];

  // Weekly only
  trends?: {
    thisWeek: WeekMetrics;
    lastWeek: WeekMetrics | null;
  };
}

export interface AnomalyFlag {
  category: "failure_rate" | "cost_spike" | "stale_task" | "agent_stuck_error";
  severity: "warning" | "critical";
  message: string;
  entityId?: string;
  entityName?: string;
  value: number;
  threshold: number;
  baseline: number;
}

export interface AgentDigestRow {
  agentId: string;
  agentName: string;
  status: string;
  runsCompleted: number;
  runsFailed: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  lastActivityAt: string | null;
}

export interface WeekMetrics {
  runsCompleted: number;
  runsFailed: number;
  issuesCreated: number;
  issuesResolved: number;
  costCents: number;
}
```

### Anomaly Detection Defaults

| Anomaly | Default Threshold | Description |
|---------|------------------|-------------|
| `failure_rate` | > 25% of runs | Agent has > 25% failed runs in the period |
| `cost_spike` | > 2x 7-day average | Company spend exceeds 2x the rolling 7-day average |
| `stale_task` | > 3 days no update | Task has had no status change in 3+ days |
| `agent_stuck_error` | > 1 hour in error | Agent has been in `error` status for 1+ hours |

### State Schema

```typescript
// Event accumulation — one key per company per day
// scopeKind: "company", scopeId: companyId, namespace: "summarize"
// stateKey: "counters-YYYY-MM-DD"
interface DailyCounters {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsCancelled: number;
  issuesCreated: number;
  issuesUpdated: number;
  approvalsCreated: number;
  approvalsDecided: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  costByAgent: Record<string, { costCents: number; inputTokens: number; outputTokens: number }>;
  runsByAgent: Record<string, { completed: number; failed: number }>;
}

// Latest digest — one key per company per type
// stateKey: "latest-daily-digest" | "latest-weekly-digest"
// value: DigestPayload (JSON)

// Last generation timestamp (for idempotency)
// stateKey: "last-daily-YYYY-MM-DD" | "last-weekly-YYYY-WW"
// value: ISO 8601 timestamp
```

## Implementation Phases

### Phase 1: SDK Capability Extensions (Separate PR)

Create a new PR for `costs.read` and `activity.read` SDK capabilities. Keep separate from PR #403 (agents.pause/resume) — agent lifecycle management and data-access capabilities are different concerns.

**Files to modify (6-layer pattern, 2x):**

#### costs.read

1. `packages/shared/src/constants.ts` — Verify `"costs.read"` exists in `PLUGIN_CAPABILITIES` (line ~316, already present)
2. `packages/plugins/sdk/src/types.ts` — Add `PluginCostsClient` interface:
   ```typescript
   export interface PluginCostsClient {
     summary(companyId: string): Promise<CostSummary>;
     byAgent(companyId: string): Promise<CostByAgent[]>;
   }
   ```
   Add `costs: PluginCostsClient` to `PluginContext` interface.
3. `packages/plugins/sdk/src/protocol.ts` — Add to `WorkerToHostMethods`:
   ```typescript
   "costs.summary": [params: { companyId: string }, result: unknown];
   "costs.byAgent": [params: { companyId: string }, result: unknown];
   ```
4. `packages/plugins/sdk/src/host-client-factory.ts` — Add `costs` to `HostServices`, add `"costs.summary": "costs.read"` and `"costs.byAgent": "costs.read"` to `METHOD_CAPABILITY_MAP`, add `gated()` handlers.
5. `packages/plugins/sdk/src/worker-rpc-host.ts` — Add `costs` client to `buildContext()`:
   ```typescript
   costs: {
     async summary(companyId: string) {
       return callHost("costs.summary", { companyId }) as any;
     },
     async byAgent(companyId: string) {
       return callHost("costs.byAgent", { companyId }) as any;
     },
   },
   ```
6. `packages/plugins/sdk/src/testing.ts` — Add costs mock with `requireCapability("costs.read")`, seed support for `CostSummary` and `CostByAgent[]` data.

#### activity.read

Same 6-layer pattern:

1. `packages/shared/src/constants.ts` — Verify `"activity.read"` exists (already present)
2. `packages/plugins/sdk/src/types.ts` — Add `list()` method to existing `PluginActivityClient`:
   ```typescript
   export interface PluginActivityClient {
     log(entry: ActivityLogEntry): Promise<void>; // existing
     list(input: { companyId: string; limit?: number; offset?: number; since?: string }): Promise<ActivityEvent[]>; // new
   }
   ```
3. `packages/plugins/sdk/src/protocol.ts` — Add `"activity.list"` to `WorkerToHostMethods`
4. `packages/plugins/sdk/src/host-client-factory.ts` — Add `"activity.list": "activity.read"` mapping, `gated()` handler
5. `packages/plugins/sdk/src/worker-rpc-host.ts` — Add `list()` to `ctx.activity` in `buildContext()`
6. `packages/plugins/sdk/src/testing.ts` — Add activity list mock with seed support

**Shared types to re-export from SDK:**
- `CostSummary`, `CostByAgent`, `CostEvent` from `packages/shared/src/types/cost.ts`
- `ActivityEvent` from `packages/shared/src/types/activity.ts`

**Build verification:**
```bash
pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/plugin-sdk build
```

### Phase 2: Plugin Skeleton

Create the plugin structure following established patterns.

**Files to create:**

```
packages/plugins/examples/plugin-summarize-example/
  package.json
  tsconfig.json
  src/
    index.ts          # re-exports manifest + worker
    types.ts          # DigestPayload, AnomalyFlag, AgentDigestRow, etc.
    manifest.ts       # capabilities, jobs, config schema, UI slots
    worker.ts         # definePlugin({ setup, onHealth, onValidateConfig })
    worker.test.ts    # vitest tests
```

#### manifest.ts

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.summarize",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Summarize (Example)",
  description: "Generates daily and weekly digest reports of agent fleet activity with anomaly detection.",
  author: "Paperclip",
  categories: ["automation", "observability"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "agents.read",
    "issues.read",
    "companies.read",
    "costs.read",
    "activity.read",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  jobs: [
    {
      jobKey: "digest-check",
      displayName: "Digest Check",
      description: "Runs every hour. Generates daily/weekly digests when the configured hour and day match.",
      schedule: "0 * * * *", // Every hour, handler checks config
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      webhookSecretRef: {
        type: "string",
        description: "Paperclip secret reference containing the webhook endpoint URL for digest delivery.",
      },
      signingSecretRef: {
        type: "string",
        description: "Optional Paperclip secret reference for HMAC-SHA256 signing of webhook payloads.",
      },
      dailyHour: {
        type: "number",
        description: "Hour of day (0-23, UTC) to generate the daily digest. Default: 8.",
        default: 8,
        minimum: 0,
        maximum: 23,
      },
      weeklyDay: {
        type: "number",
        description: "Day of week (0=Sun, 1=Mon, ..., 6=Sat) to generate the weekly digest. Default: 1 (Monday).",
        default: 1,
        minimum: 0,
        maximum: 6,
      },
      anomalyThresholds: {
        type: "object",
        description: "Override default anomaly detection thresholds.",
        properties: {
          failureRatePercent: { type: "number", default: 25 },
          costSpikeMultiplier: { type: "number", default: 2 },
          staleDays: { type: "number", default: 3 },
          errorStuckMinutes: { type: "number", default: 60 },
        },
      },
    },
    required: [],
  },
};

export default manifest;
```

### Phase 3: Event Accumulators

Register event handlers in `setup()` that increment counters in `ctx.state`.

**Events to subscribe to:**
- `agent.run.started` → increment `runsStarted`
- `agent.run.finished` → increment `runsCompleted`, update `runsByAgent`
- `agent.run.failed` → increment `runsFailed`, update `runsByAgent`
- `agent.run.cancelled` → increment `runsCancelled`
- `cost_event.created` → increment `costCents`, `inputTokens`, `outputTokens`, update `costByAgent`
- `issue.created` → increment `issuesCreated`
- `issue.updated` → increment `issuesUpdated` (filter for status changes to detect resolutions)
- `approval.created` → increment `approvalsCreated`
- `approval.decided` → increment `approvalsDecided`

**State key pattern:**
```typescript
const counterKey = (companyId: string, date: string): ScopeKey => ({
  scopeKind: "company",
  scopeId: companyId,
  namespace: "summarize",
  stateKey: `counters-${date}`, // YYYY-MM-DD
});
```

**Accumulation helper:**
```typescript
async function incrementCounter(
  ctx: PluginContext,
  companyId: string,
  updater: (counters: DailyCounters) => void,
) {
  const today = new Date().toISOString().slice(0, 10);
  const key = counterKey(companyId, today);
  const current = (await ctx.state.get(key)) as DailyCounters | null;
  const counters: DailyCounters = current ?? emptyCounters();
  updater(counters);
  await ctx.state.set(key, counters);
}
```

### Phase 4: Digest Generator (Scheduled Job)

The `digest-check` job handler:

1. Read config to get `dailyHour` and `weeklyDay`
2. Check if the current UTC hour matches `dailyHour` — if not, return early (no-op)
3. Check if today is `weeklyDay` — if so, generate both daily and weekly
4. Iterate active companies via `ctx.companies.list()`
5. For each company:
   a. Check idempotency key (`last-daily-YYYY-MM-DD`) — skip if already generated
   b. Read **yesterday's** counters from `ctx.state` (avoids race with event handlers)
   c. Pull live snapshots: `ctx.agents.list()`, `ctx.issues.list()`, `ctx.costs.summary()`, `ctx.costs.byAgent()`
   d. Read 7 days of historical counters for anomaly baseline
   e. Compute anomaly flags
   f. Build `DigestPayload`
   g. Store digest in state (`latest-daily-digest`)
   h. Set idempotency marker
   i. If webhook configured, deliver via `ctx.http.fetch()`
   j. Log activity and write metrics

**Graceful degradation:** Each SDK call wrapped in try/catch. If `ctx.costs.summary()` fails, set `costs: null` in payload. If `ctx.agents.list()` fails, omit `agentBreakdown`. Never throw from the job handler unless all data sources fail.

### Phase 5: Anomaly Detection

Compare current period metrics against rolling 7-day average:

```typescript
function detectAnomalies(
  current: DailyCounters,
  history: DailyCounters[], // Previous 7 days
  agents: Agent[],
  thresholds: AnomalyThresholds,
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  // Failure rate per agent
  for (const [agentId, runs] of Object.entries(current.runsByAgent)) {
    const total = runs.completed + runs.failed;
    if (total > 0 && (runs.failed / total) * 100 > thresholds.failureRatePercent) {
      flags.push({ category: "failure_rate", severity: "warning", ... });
    }
  }

  // Cost spike vs 7-day average
  if (history.length > 0) {
    const avgCost = history.reduce((s, h) => s + h.costCents, 0) / history.length;
    if (avgCost > 0 && current.costCents > avgCost * thresholds.costSpikeMultiplier) {
      flags.push({ category: "cost_spike", severity: "critical", ... });
    }
  }

  // Agents stuck in error
  for (const agent of agents) {
    if (agent.status === "error") {
      // Note: updatedAt comparison requires agent.updatedAt from ctx.agents.list()
      flags.push({ category: "agent_stuck_error", severity: "warning", ... });
    }
  }

  return flags;
}
```

### Phase 6: Dashboard Widget Data Handler

```typescript
ctx.data.register("latest-digest", async (params) => {
  const companyId = params.companyId as string;
  if (!companyId) return null;

  const daily = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "summarize",
    stateKey: "latest-daily-digest",
  });

  const weekly = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "summarize",
    stateKey: "latest-weekly-digest",
  });

  return { daily, weekly };
});
```

### Phase 7: Webhook Delivery

```typescript
async function deliverWebhook(
  ctx: PluginContext,
  config: ParsedConfig,
  digest: DigestPayload,
): Promise<boolean> {
  if (!config.webhookRef) return false;

  const webhookUrl = await ctx.secrets.resolve(config.webhookRef);
  const body = JSON.stringify(digest);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Paperclip-Summarize/1.0",
  };

  if (config.signingRef) {
    const secret = await ctx.secrets.resolve(config.signingRef);
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Paperclip-Signature"] = `sha256=${signature}`;
  }

  const response = await ctx.http.fetch(webhookUrl, { method: "POST", headers, body });
  if (!response.ok) {
    throw new Error(`Webhook responded with ${response.status}`);
  }
  return true;
}
```

### Phase 8: State Cleanup

During weekly digest generation, delete counter keys older than 30 days:

```typescript
async function cleanupOldState(ctx: PluginContext, companyId: string) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (let d = 30; d < 60; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().slice(0, 10);
    await ctx.state.delete({
      scopeKind: "company",
      scopeId: companyId,
      namespace: "summarize",
      stateKey: `counters-${dateStr}`,
    });
  }
}
```

### Phase 9: Tests

Comprehensive test suite using `createTestHarness`:

1. **Event accumulation tests** — emit events, verify counters in state
2. **Daily digest generation** — seed agents/issues/costs, run job, verify digest in state
3. **Weekly digest generation** — seed 7 days of counters, run job, verify trends
4. **Anomaly detection** — seed data with high failure rates / cost spikes, verify flags
5. **Webhook delivery** — mock `ctx.http.fetch`, verify POST body matches `DigestPayload`
6. **HMAC signing** — verify signature header when `signingSecretRef` configured
7. **First run (no history)** — verify `historicalDays: 0` and no anomaly false positives
8. **Partial failure** — mock `ctx.costs.summary` to throw, verify graceful degradation
9. **Idempotency** — run job twice for same day, verify single webhook delivery
10. **Config validation** — verify `dailyHour` range, `weeklyDay` range
11. **Dashboard widget** — call `getData("latest-digest")`, verify response shape
12. **Health check** — verify `onHealth()` returns ok
13. **State cleanup** — verify old keys deleted after weekly run

## Acceptance Criteria

### Functional Requirements

- [ ] Plugin subscribes to `agent.run.*`, `cost_event.created`, `issue.created`, `issue.updated`, `approval.created`, `approval.decided` events and accumulates counters in `ctx.state`
- [ ] Daily digest job generates a `DigestPayload` for each active company at the configured hour
- [ ] Weekly digest job generates a digest with week-over-week trend comparisons
- [ ] Anomaly detection flags failure rate spikes, cost spikes, stale tasks, and stuck agents
- [ ] Dashboard widget serves the latest digest via `ctx.data.register("latest-digest")`
- [ ] Webhook delivery sends `DigestPayload` as JSON POST with optional HMAC signing
- [ ] Idempotency: duplicate job runs for the same period don't produce duplicate webhooks
- [ ] Graceful degradation: partial SDK failures produce partial digests, not job failures
- [ ] State cleanup removes counter keys older than 30 days during weekly runs

### Non-Functional Requirements

- [ ] All capabilities declared in manifest match actual usage
- [ ] Config schema has proper validation (dailyHour 0-23, weeklyDay 0-6)
- [ ] No hardcoded values — all thresholds configurable via `anomalyThresholds`

### Quality Gates

- [ ] 13+ tests covering all major flows
- [ ] `pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/plugin-sdk build` passes
- [ ] Plugin typechecks and builds: `pnpm --filter plugin-summarize-example typecheck && pnpm --filter plugin-summarize-example build`
- [ ] All existing SDK tests still pass

## Dependencies & Prerequisites

- **Separate PR** for `costs.read` and `activity.read` SDK capabilities must be created and merged first (Phase 1)
- **PR #403** (agents.pause/resume) is independent — no dependency between these
- **PR #396** (Plugin Support) must be merged or available on the target branch
- No database schema changes required
- No server-side changes required (SDK-only + plugin)

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| `costs.read` server-side handler not wired | Plugin gets null cost data | Graceful degradation — `costs: null` in digest. Document that server-side wiring is needed for full functionality. |
| Hourly cron + config check has up to 59-min slop | Digest arrives at unexpected time | Document in README. Alternative: run every 15 minutes (`*/15 * * * *`) for tighter accuracy. |
| State read-modify-write race in event handlers | Minor counter inaccuracy | Previous-day read pattern avoids most races. Accept minor inaccuracy for simplicity. |
| Large number of companies slows job | Long job execution | Paginate company list, process sequentially, log progress. |

## Git Workflow

Branch from `origin/master` (upstream contribution):

```bash
git fetch origin master
git checkout -b feat/summarize-plugin origin/master
```

Pre-push sanity check: `git log --oneline origin/master..HEAD` should show ONLY your commits.

## References & Research

### Internal References

- Brainstorm: `docs/brainstorms/2026-03-09-summarize-plugin-brainstorm.md`
- 6-layer SDK pattern: `docs/plans/2026-03-09-feat-plugin-sdk-agents-pause-resume-plan.md`
- SDK types: `packages/plugins/sdk/src/types.ts` (PluginContext at line ~892)
- Shared types: `packages/shared/src/types/cost.ts`, `packages/shared/src/types/activity.ts`, `packages/shared/src/types/dashboard.ts`
- Constants: `packages/shared/src/constants.ts` (PLUGIN_CAPABILITIES, PLUGIN_EVENT_TYPES, PLUGIN_STATE_SCOPE_KINDS)
- Protocol: `packages/plugins/sdk/src/protocol.ts` (WorkerToHostMethods)
- Host-client-factory: `packages/plugins/sdk/src/host-client-factory.ts` (METHOD_CAPABILITY_MAP, HostServices)
- Worker-RPC-host: `packages/plugins/sdk/src/worker-rpc-host.ts` (buildContext)
- Testing: `packages/plugins/sdk/src/testing.ts` (createTestHarness)
- Git workflow: `docs/solutions/git-workflow/dirty-pr-history-from-fork-branch.md`

### Pattern References (Existing Plugins)

- Scheduled job example: `packages/plugins/examples/plugin-scheduled-job-example/`
- Discord notifier: `packages/plugins/examples/plugin-discord-notifier-example/`
- Webhook notifier: `packages/plugins/examples/plugin-webhook-notifier-example/`
- Slack notifier: `packages/plugins/examples/plugin-slack-notifier-example/`
- Claude quota launcher (ctx.data.register): `packages/plugins/examples/plugin-claude-quota-launcher-example/`
- File browser (multiple ctx.data handlers): `packages/plugins/examples/plugin-file-browser-example/`

### Related Work

- PR #396: Plugin Support (foundation)
- PR #398: Webhook + Discord notifier plugins
- PR #402: Email notifier plugin
- PR #403: agents.pause/resume SDK capabilities (separate, independent PR)
- New PR: costs.read + activity.read SDK capabilities (prerequisite for Summarize plugin)
