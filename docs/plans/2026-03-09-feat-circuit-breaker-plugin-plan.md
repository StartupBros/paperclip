---
title: "feat: Circuit Breaker Plugin"
type: feat
date: 2026-03-09
---

# feat: Circuit Breaker Plugin (#390)

## Overview

A circuit breaker plugin for Paperclip using the plugin SDK (PR #396) that detects runaway agents and auto-pauses them before they burn through budgets. Addresses the #1 pain point in the repo (issues #390 and #373): agents get stuck in loops burning tokens with no progress, and the budget system only catches it retroactively.

The plugin subscribes to agent run lifecycle events, tracks failure and progress patterns using scoped state, and pauses agents when configurable thresholds are tripped. Recovery is manual by default, with an opt-in half-open circuit breaker pattern for auto-recovery.

This is the third community plugin in our contribution arc (after webhook and discord notifiers in PR #398), proving the plugin architecture handles real operational problems — not just notifications.

## Problem Statement

**Issue #373:** Agents burn hundreds of thousands of tokens overnight with no tasks — every heartbeat cycle bootstraps the agent even when idle.

**Issue #390:** Proposes a circuit breaker to detect wasteful behavior during execution, before the monthly budget hard-stop kicks in. Three failure modes:
1. Agents fail repeatedly (adapter errors, crashes)
2. Agents "succeed" but produce no work (no issues modified, no comments posted)
3. Token usage spikes abnormally (loops, runaway context)

**Why not PR #391?** That PR bakes the circuit breaker directly into heartbeat.ts with server-side mutations. The automated reviewer flagged it 2/5 for race conditions, coverage gaps, and thin tests. The maintainer explicitly redirected our notification work to plugins (PR #389) — the same logic applies here.

## Proposed Solution

A plugin using `definePlugin()` from `@paperclipai/plugin-sdk` that:

1. **Subscribes** to `agent.run.finished` and `agent.run.failed` events
2. **Tracks** per-agent counters and rolling averages in `ctx.state` (scoped, race-free)
3. **Evaluates** three detection strategies on each event
4. **Pauses** agents via `ctx.agents.pause()` when thresholds are exceeded
5. **Recovers** manually (default) or via half-open pattern with a polling cron job
6. **Logs** all actions via `ctx.activity.log` and `ctx.metrics.write`
7. **Emits** custom `plugin.circuit_breaker.tripped` / `plugin.circuit_breaker.reset` events for composition with notification plugins

## Technical Approach

### Architecture

```
Event Bus                Plugin Worker                    State Store
─────────       ┌──────────────────────────┐       ─────────────────
                │                          │
agent.run.  ──► │  1. Parse event          │
finished/       │  2. Load agent config    │ ◄──── ctx.agents.get()
failed          │     (instance + override)│
                │  3. Load agent state     │ ◄──── ctx.state.get()
                │  4. Run detectors:       │
                │     - failures           │
                │     - no-progress        │
                │     - token velocity     │
                │  5. Update state         │ ────► ctx.state.set()
                │  6. If tripped:          │
                │     - ctx.agents.pause() │ ────► Agent paused
                │     - ctx.activity.log() │ ────► Audit trail
                │     - ctx.metrics.write()│ ────► Dashboard
                │     - ctx.events.emit()  │ ────► Notification plugins
                └──────────────────────────┘

Cron Job (every 5 min, if half-open enabled)
                ┌──────────────────────────┐
                │  1. Scan open circuits   │ ◄──── ctx.state (scan)
                │  2. Check cooldown       │
                │  3. Resume trial run     │ ────► ctx.agents.resume()
                │  4. Mark half-open       │ ────► ctx.state.set()
                └──────────────────────────┘
```

### File Structure

```
packages/plugins/examples/plugin-circuit-breaker-example/
  src/
    index.ts              # Barrel export (manifest + worker)
    manifest.ts           # Plugin manifest with capabilities and config schema
    worker.ts             # definePlugin() + runWorker() — all detection and recovery logic
    worker.test.ts        # Comprehensive vitest tests using createTestHarness
    types.ts              # Shared TypeScript interfaces (config, state, detectors)
  tsconfig.json           # extends ../../../../tsconfig.json
  vitest.config.ts        # { test: { environment: "node" } }
  package.json            # @paperclipai/plugin-sdk workspace dep
```

### Implementation Phases

#### Phase 1: Foundation — Manifest, Types, Config Parsing

Set up the plugin skeleton following the discord/webhook notifier pattern.

**`manifest.ts`** — Plugin declaration:

```typescript
// packages/plugins/examples/plugin-circuit-breaker-example/src/manifest.ts
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.circuit-breaker",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Circuit Breaker (Example)",
  description: "Detects runaway agents via consecutive failures, no-progress runs, and token velocity spikes. Auto-pauses agents when configurable thresholds are tripped.",
  author: "Paperclip",
  categories: ["automation", "monitoring"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "agents.read",
    "agents.pause",
    "agents.resume",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  jobs: [
    {
      jobKey: "half-open-recovery",
      displayName: "Half-Open Recovery Check",
      description: "Polls open circuits for cooldown expiry and resumes agents for trial runs.",
      schedule: "*/5 * * * *",  // every 5 minutes
    },
    {
      jobKey: "state-cleanup",
      displayName: "Orphaned State Cleanup",
      description: "Removes circuit breaker state for agents that no longer exist.",
      schedule: "0 3 * * 0",  // weekly, Sunday 3am
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        description: "Master switch for the circuit breaker.",
        default: true,
      },
      maxConsecutiveFailures: {
        type: "integer",
        description: "Number of consecutive failed runs before tripping.",
        default: 3,
        minimum: 1,
      },
      maxConsecutiveNoProgress: {
        type: "integer",
        description: "Number of consecutive no-progress runs before tripping.",
        default: 5,
        minimum: 1,
      },
      tokenVelocityMultiplier: {
        type: "number",
        description: "Trip when a run's token usage exceeds this multiple of the rolling average.",
        default: 3.0,
        minimum: 1.1,
      },
      tokenVelocityWindowSize: {
        type: "integer",
        description: "Number of recent runs to include in the rolling average.",
        default: 20,
        minimum: 4,
      },
      recovery: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["manual", "half-open"],
            default: "manual",
          },
          cooldownMinutes: {
            type: "integer",
            description: "Minutes before a half-open trial run is attempted.",
            default: 30,
            minimum: 5,
          },
        },
      },
    },
  },
};
```

**`types.ts`** — Shared interfaces:

```typescript
// packages/plugins/examples/plugin-circuit-breaker-example/src/types.ts

/** Circuit states following the classic pattern */
type CircuitState = "closed" | "open" | "half-open";

/** Detection strategies that can trip the breaker */
type TripReason = "consecutive_failures" | "no_progress" | "token_velocity";

/** Merged config (instance defaults + per-agent overrides) */
interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveFailures: number;
  maxConsecutiveNoProgress: number;
  tokenVelocityMultiplier: number;
  tokenVelocityWindowSize: number;
  recovery: {
    mode: "manual" | "half-open";
    cooldownMinutes: number;
  };
}

/** Per-agent state persisted in ctx.state */
interface AgentCircuitState {
  circuitState: CircuitState;
  consecutiveFailures: number;
  consecutiveNoProgress: number;
  tokenCostHistory: number[];
  tripReasons: TripReason[];
  trippedAt: string | null;       // ISO timestamp
  lastEventAt: string | null;     // ISO timestamp
}

/** Defaults for a fresh agent (no state yet) */
const DEFAULT_AGENT_STATE: AgentCircuitState = {
  circuitState: "closed",
  consecutiveFailures: 0,
  consecutiveNoProgress: 0,
  tokenCostHistory: [],
  tripReasons: [],
  trippedAt: null,
  lastEventAt: null,
};

/** Defaults for instance config */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  maxConsecutiveFailures: 3,
  maxConsecutiveNoProgress: 5,
  tokenVelocityMultiplier: 3.0,
  tokenVelocityWindowSize: 20,
  recovery: { mode: "manual", cooldownMinutes: 30 },
};
```

**Tasks:**
- [x] Create `package.json` with `@paperclipai/plugin-sdk` workspace dep (`manifest.ts`)
- [x] Create `tsconfig.json` extending root (`tsconfig.json`)
- [x] Create `vitest.config.ts` (`vitest.config.ts`)
- [x] Create `manifest.ts` with full config schema and capabilities (`manifest.ts`)
- [x] Create `types.ts` with `CircuitBreakerConfig`, `AgentCircuitState`, defaults (`types.ts`)
- [x] Create `index.ts` barrel export (`index.ts`)

#### Phase 2: Core Detection Logic

Implement the three detectors and the event handler in `worker.ts`.

**Event handler flow** (pseudocode):

```typescript
// worker.ts — inside setup(ctx)

ctx.events.on("agent.run.finished", async (event) => {
  const agentId = event.payload.agentId as string;
  const companyId = event.companyId;

  // 1. Load merged config (instance + per-agent override)
  const config = await getMergedConfig(ctx, agentId, companyId);
  if (!config.enabled) return;

  // 2. Load current state (or defaults)
  const state = await getAgentState(ctx, agentId);

  // 3. If circuit is open, a successful run during half-open = reset
  if (state.circuitState === "half-open") {
    await resetCircuit(ctx, agentId, companyId, state);
    return;
  }

  // 4. Reset failure counter (this was a successful run)
  state.consecutiveFailures = 0;

  // 5. Run no-progress detector
  const hasProgress = checkProgress(event.payload);
  if (hasProgress) {
    state.consecutiveNoProgress = 0;
  } else {
    state.consecutiveNoProgress += 1;
  }

  // 6. Run token velocity detector
  const tokenCost = extractTokenCost(event.payload);
  if (tokenCost !== null) {
    state.tokenCostHistory.push(tokenCost);
    // Trim to window size
    if (state.tokenCostHistory.length > config.tokenVelocityWindowSize) {
      state.tokenCostHistory = state.tokenCostHistory.slice(-config.tokenVelocityWindowSize);
    }
  }

  // 7. Evaluate thresholds
  const tripReasons: TripReason[] = [];

  if (state.consecutiveNoProgress >= config.maxConsecutiveNoProgress) {
    tripReasons.push("no_progress");
  }

  if (tokenCost !== null && shouldTripVelocity(state, config, tokenCost)) {
    tripReasons.push("token_velocity");
  }

  // 8. Trip or save state
  state.lastEventAt = event.occurredAt;

  if (tripReasons.length > 0) {
    await tripCircuit(ctx, agentId, companyId, state, tripReasons);
  } else {
    await saveAgentState(ctx, agentId, state);
  }
});

ctx.events.on("agent.run.failed", async (event) => {
  // Similar flow but:
  // - Increment consecutiveFailures
  // - Do NOT reset no-progress counter (failed runs don't prove progress)
  // - Run token velocity detector on usage if available
  // - Check consecutiveFailures >= maxConsecutiveFailures
  // - If half-open, re-trip immediately
});
```

**Detection functions:**

```typescript
/** No-progress: check resultJson from event payload */
function checkProgress(payload: Record<string, unknown>): boolean {
  const result = payload.resultJson as Record<string, unknown> | undefined;
  if (!result) {
    // resultJson not in payload yet (upstream PR pending)
    // Conservatively assume progress was made to avoid false positives
    return true;
  }
  const modified = (result.issuesModified as number) ?? 0;
  const created = (result.issuesCreated as number) ?? 0;
  const comments = (result.commentsPosted as number) ?? 0;
  return modified > 0 || created > 0 || comments > 0;
}

/** Token velocity: compare latest cost to rolling average */
function shouldTripVelocity(
  state: AgentCircuitState,
  config: CircuitBreakerConfig,
  latestCost: number
): boolean {
  const minSamples = Math.ceil(config.tokenVelocityWindowSize / 2);
  if (state.tokenCostHistory.length < minSamples) return false;

  const avg = state.tokenCostHistory.reduce((a, b) => a + b, 0)
            / state.tokenCostHistory.length;
  if (avg === 0) return false;

  return latestCost > avg * config.tokenVelocityMultiplier;
}

/** Extract numeric token cost from usage payload */
function extractTokenCost(payload: Record<string, unknown>): number | null {
  const usage = payload.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  // Prefer totalTokens, fall back to input + output
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  return input + output > 0 ? input + output : null;
}
```

**Trip action:**

```typescript
async function tripCircuit(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
  state: AgentCircuitState,
  reasons: TripReason[]
): Promise<void> {
  // Check if already paused (avoid redundant action)
  const agent = await ctx.agents.get(agentId, companyId);
  if (agent.status === "paused" || agent.status === "terminated") {
    // Still update state to track the trip
    state.circuitState = "open";
    state.tripReasons = reasons;
    state.trippedAt = new Date().toISOString();
    await saveAgentState(ctx, agentId, state);
    return;
  }

  // Pause the agent
  await ctx.agents.pause(agentId, companyId);

  // Update state
  state.circuitState = "open";
  state.tripReasons = reasons;
  state.trippedAt = new Date().toISOString();
  await saveAgentState(ctx, agentId, state);

  // Audit trail
  await ctx.activity.log({
    companyId,
    message: `Circuit breaker tripped for agent ${agent.name}: ${reasons.join(", ")}`,
    entityType: "agent",
    entityId: agentId,
    metadata: { reasons, state: summarizeState(state) },
  });

  // Metrics
  for (const reason of reasons) {
    await ctx.metrics.write(`circuit_breaker.tripped.${reason}`, 1);
  }
  await ctx.metrics.write("circuit_breaker.tripped", 1);

  // Emit custom event for notification plugin composition
  await ctx.events.emit("plugin.circuit_breaker.tripped", companyId, {
    agentId,
    agentName: agent.name,
    reasons,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveNoProgress: state.consecutiveNoProgress,
    circuitState: "open",
  });
}
```

**Tasks:**
- [x] Implement `getMergedConfig()` — reads instance config + agent runtimeConfig override with validation and fallback (`worker.ts`)
- [x] Implement `getAgentState()` / `saveAgentState()` — ctx.state read/write with defaults (`worker.ts`)
- [x] Implement `checkProgress()` — no-progress detector with graceful resultJson fallback (`worker.ts`)
- [x] Implement `shouldTripVelocity()` — token velocity detector with cold-start guard (`worker.ts`)
- [x] Implement `extractTokenCost()` — usage payload parser (`worker.ts`)
- [x] Implement `tripCircuit()` — pause + log + metrics + emit (`worker.ts`)
- [x] Implement `resetCircuit()` — close circuit + clear counters + log + emit (`worker.ts`)
- [x] Implement `agent.run.finished` event handler (`worker.ts`)
- [x] Implement `agent.run.failed` event handler (`worker.ts`)

#### Phase 3: Half-Open Recovery (Cron Job)

The SDK's `ctx.jobs` only supports cron-scheduled recurring jobs (not one-shot delayed jobs). The half-open recovery uses a **polling cron job** that runs every 5 minutes and checks which open circuits have exceeded their cooldown.

```typescript
// worker.ts — inside setup(ctx)

ctx.jobs.register("half-open-recovery", async () => {
  const config = await getParsedConfig(ctx);
  if (config.recovery.mode !== "half-open") return;

  // Scan all agent states for open circuits past cooldown
  // NOTE: This requires iterating known agent IDs from state.
  // We maintain a state key "tracked_agents" with the set of agent IDs
  // that have any circuit breaker state.
  const trackedAgents = await getTrackedAgentIds(ctx);

  for (const agentId of trackedAgents) {
    const state = await getAgentState(ctx, agentId);
    if (state.circuitState !== "open" || !state.trippedAt) continue;

    const elapsed = Date.now() - new Date(state.trippedAt).getTime();
    const cooldownMs = config.recovery.cooldownMinutes * 60 * 1000;
    if (elapsed < cooldownMs) continue;

    // Cooldown expired — attempt half-open recovery
    try {
      const agent = await ctx.agents.get(agentId, /* companyId from state */);
      if (agent.status !== "paused") {
        // Agent was manually resumed or terminated — close circuit
        await resetCircuit(ctx, agentId, agent.companyId, state);
        continue;
      }

      // Resume agent for trial run
      await ctx.agents.resume(agentId, agent.companyId);
      state.circuitState = "half-open";
      await saveAgentState(ctx, agentId, state);

      await ctx.activity.log({
        companyId: agent.companyId,
        message: `Circuit breaker entering half-open state for agent ${agent.name} — trial run allowed`,
        entityType: "agent",
        entityId: agentId,
      });

      await ctx.metrics.write("circuit_breaker.half_open", 1);
    } catch (err) {
      // Agent may have been deleted — clean up state
      ctx.logger.warn(`Half-open recovery failed for agent ${agentId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
```

**Tracked agent registry:** The plugin maintains a state key at instance scope listing all agent IDs with circuit breaker state. Updated whenever a new agent is first seen:

```typescript
async function trackAgent(ctx: PluginContext, agentId: string, companyId: string): Promise<void> {
  const key = { scopeKind: "instance" as const, stateKey: "tracked_agents" };
  const existing = ((await ctx.state.get(key)) as Record<string, string>) ?? {};
  if (existing[agentId]) return;
  existing[agentId] = companyId;
  await ctx.state.set(key, existing);
}
```

**Tasks:**
- [x] Implement `half-open-recovery` cron job handler (`worker.ts`)
- [x] Implement `trackAgent()` / `getTrackedAgentIds()` for agent registry (`worker.ts`)
- [x] Handle half-open → closed transition in `agent.run.finished` handler (`worker.ts`)
- [x] Handle half-open → re-trip in `agent.run.failed` handler (`worker.ts`)
- [x] Implement `state-cleanup` cron job — removes state for deleted agents (`worker.ts`)

#### Phase 4: Config Validation, Health, Lifecycle

```typescript
// worker.ts

async onValidateConfig(config) {
  const errors: string[] = [];

  if (config.maxConsecutiveFailures !== undefined) {
    const v = config.maxConsecutiveFailures as number;
    if (!Number.isInteger(v) || v < 1) errors.push("maxConsecutiveFailures must be integer >= 1");
  }

  if (config.maxConsecutiveNoProgress !== undefined) {
    const v = config.maxConsecutiveNoProgress as number;
    if (!Number.isInteger(v) || v < 1) errors.push("maxConsecutiveNoProgress must be integer >= 1");
  }

  if (config.tokenVelocityMultiplier !== undefined) {
    const v = config.tokenVelocityMultiplier as number;
    if (typeof v !== "number" || v < 1.1) errors.push("tokenVelocityMultiplier must be >= 1.1");
  }

  const recovery = config.recovery as Record<string, unknown> | undefined;
  if (recovery?.mode && !["manual", "half-open"].includes(recovery.mode as string)) {
    errors.push('recovery.mode must be "manual" or "half-open"');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
},

async onHealth() {
  return { status: "ok", message: "Circuit breaker plugin operational" };
},
```

**Tasks:**
- [x] Implement `onValidateConfig()` with bounds checking (`worker.ts`)
- [x] Implement `onHealth()` (`worker.ts`)
- [x] Implement per-agent config validation in `getMergedConfig()` — log warnings for invalid overrides, fall back to instance defaults (`worker.ts`)

#### Phase 5: Tests

Follow the discord notifier test pattern. Target 15+ tests covering all detection strategies, state transitions, config merging, and edge cases.

**Test plan:**

```typescript
// worker.test.ts

describe("circuit-breaker plugin", () => {
  // Setup & validation
  it("validates config requires valid thresholds");
  it("reports healthy");

  // Consecutive failure detection
  it("trips after maxConsecutiveFailures consecutive failures");
  it("resets failure counter on successful run");
  it("ignores cancelled runs (no counter change)");

  // No-progress detection
  it("trips after maxConsecutiveNoProgress runs with no progress");
  it("resets no-progress counter when resultJson shows progress");
  it("assumes progress when resultJson is missing (graceful fallback)");

  // Token velocity detection
  it("trips when token cost exceeds velocity multiplier × rolling average");
  it("skips velocity check during cold start (insufficient history)");
  it("trims token history to window size");

  // Circuit state transitions
  it("does not double-pause already-paused agents");
  it("emits single trip event when multiple detectors trigger");
  it("resets circuit on successful run during half-open state");
  it("re-trips on failure during half-open state");

  // Config merging
  it("uses instance defaults when no per-agent override exists");
  it("merges per-agent runtimeConfig override over instance defaults");
  it("skips detection when per-agent config sets enabled: false");
  it("falls back to defaults for invalid per-agent overrides");

  // Half-open recovery job
  it("resumes agent after cooldown expires");
  it("skips agents still within cooldown");
  it("cleans up state for deleted agents");

  // Observability
  it("logs activity on circuit trip with reasons");
  it("writes metrics per detection strategy");
  it("emits plugin.circuit_breaker.tripped custom event");
  it("emits plugin.circuit_breaker.reset on recovery");
});
```

**Tasks:**
- [x] Write test setup with `createTestHarness`, manifest, seeded agents (`worker.test.ts`)
- [x] Write consecutive failure detection tests (3 tests) (`worker.test.ts`)
- [x] Write no-progress detection tests (3 tests) (`worker.test.ts`)
- [x] Write token velocity detection tests (3 tests) (`worker.test.ts`)
- [x] Write circuit state transition tests (4 tests) (`worker.test.ts`)
- [x] Write config merging tests (4 tests) (`worker.test.ts`)
- [x] Write half-open recovery job tests (3 tests) (`worker.test.ts`)
- [x] Write observability tests (4 tests) (`worker.test.ts`)

## Edge Cases and Design Decisions

### Resolved from SpecFlow Analysis

| Edge Case | Decision | Rationale |
|-----------|----------|-----------|
| **`agent.run.cancelled` handling** | Ignore entirely — don't reset or increment any counters | Cancel is neither success nor failure. Counting it either way causes confusion. |
| **Multiple detectors trip simultaneously** | Single `agents.pause()` call (idempotent), single activity log entry with all reasons, single custom event with `reasons[]` array | Avoids duplicate notifications and confusing audit trails. |
| **Token velocity cold start** | Skip velocity checks until history has `≥ ceil(windowSize/2)` entries | Small samples produce volatile averages and false positives. |
| **Counter read-modify-write race** | Accept eventual consistency — counter may drift by 1-2 | Thresholds of 3-5 make drift of 1 negligible. Plugin state is scoped per-plugin-instance, and event delivery is sequential per-handler in the SDK host. |
| **Missing `resultJson` in payload** | Conservatively assume progress was made (return `true` from `checkProgress`) | No false positives when upstream PR hasn't merged yet. No-progress detection activates automatically once enriched payloads land. |
| **Already-paused agent** | Skip `agents.pause()` call if agent status is already `paused` or `terminated` but still update circuit state in `ctx.state` | Avoids unnecessary RPC. State stays consistent regardless of who paused. |
| **Manual resume detection** | On `agent.run.finished`/`agent.run.failed`, check stored circuit state. If circuit was `open` but agent is running, operator must have manually resumed — reset circuit to `closed`. | Simpler than listening to `agent.status_changed` and trying to detect transitions. |
| **Per-agent config validation** | Validate on each read, log warning for invalid values, fall back to instance defaults | Can't validate at install time since runtimeConfig is set independently. |
| **Per-agent `enabled: false`** | Supported. Plugin checks merged config first and returns early. | Operators need escape hatches for agents with unusual patterns. |
| **State cleanup for deleted agents** | Weekly cron job scans tracked agent IDs, calls `ctx.agents.get()`, removes state for agents that throw (deleted/not found) | Prevents state leak without an `agent.deleted` event. |
| **Plugin restart/crash** | `ctx.state` persists in Postgres. On restart, cron job picks up open circuits. No in-memory state needed. | Stateless worker design — all state in `ctx.state`. |
| **Config changes mid-operation** | New thresholds take effect on next event. No retroactive evaluation. | Simple, predictable. Operator can manually resume agents if new thresholds are more lenient. |

### Catastrophic Adapter Failures (Known Limitation)

When an adapter crashes catastrophically (unhandled exception in the heartbeat catch block), only a `LiveEvent` is emitted — **not** a domain event. The circuit breaker plugin is blind to these failures.

This is a platform gap documented in the brainstorm's open questions. It should be raised as a follow-up issue: the catch block in heartbeat.ts (line ~1517) should also call `emitDomainEvent` with `agent.run.failed`.

## Dependencies & Prerequisites

| Dependency | Status | Impact |
|-----------|--------|--------|
| **PR #396** — Plugin SDK | In progress | Foundation. Plugin cannot exist without it. |
| **PR #403** — `agents.pause` + `agents.resume` | Opened | Required for the pause action. Without it, plugin can only detect and notify. |
| **New PR** — Enrich `agent.run.finished` payload with `resultJson` | Not yet opened | Required for no-progress detection. Plugin gracefully degrades without it — assumes progress. |

**Dependency strategy:** The plugin can be developed and tested now using the SDK test harness (which already mocks `agents.pause`). The upstream payload enrichment PR can land independently. The plugin gracefully handles its absence.

## SDK Capabilities Exercised

This plugin exercises **8 capabilities** — the broadest SDK surface area of any community plugin:

| # | Capability | Usage |
|---|-----------|-------|
| 1 | `events.subscribe` | Listen to `agent.run.finished`, `agent.run.failed` |
| 2 | `events.emit` | Emit `plugin.circuit_breaker.tripped` and `.reset` |
| 3 | `agents.read` | Check agent status and runtimeConfig before acting |
| 4 | `agents.pause` | Pause runaway agents |
| 5 | `agents.resume` | Resume agents for half-open trial runs |
| 6 | `plugin.state.read/write` | Track counters, circuit state, rolling averages per agent |
| 7 | `jobs.schedule` | Polling cron for half-open recovery + state cleanup |
| 8 | `activity.log.write` | Audit trail for all circuit transitions |
| 9 | `metrics.write` | Dashboard metrics per detection strategy |

## Acceptance Criteria

### Functional Requirements

- [ ] Plugin installs and starts cleanly via the plugin SDK host
- [ ] Consecutive failure detection trips after N failed runs (configurable, default 3)
- [ ] No-progress detection trips after N zero-progress runs (configurable, default 5) — gracefully skips when `resultJson` is absent
- [ ] Token velocity detection trips when cost exceeds multiplier × rolling average (configurable) — skips during cold start
- [ ] Tripped circuit pauses the agent via `ctx.agents.pause()`
- [ ] Manual recovery: agent resumes when operator un-pauses via UI
- [ ] Half-open recovery: after cooldown, agent resumes for trial run; success closes circuit, failure re-trips
- [ ] Instance-level config with per-agent overrides via `runtimeConfig.circuitBreaker`
- [ ] Per-agent `enabled: false` disables the circuit breaker for that agent

### Non-Functional Requirements

- [ ] All state in `ctx.state` (stateless worker — survives restarts)
- [ ] Custom events emitted for notification plugin composition
- [ ] Activity log entries for all circuit transitions (trip, reset, half-open)
- [ ] Metrics written per detection strategy

### Quality Gates

- [x] 26 vitest tests passing via `createTestHarness`
- [x] `pnpm typecheck` passes
- [x] `pnpm build` produces clean output
- [x] Follows existing plugin conventions (manifest, worker, test patterns match agent-routines example)

## Custom Events Schema

For notification plugin composition:

```typescript
// plugin.circuit_breaker.tripped
{
  agentId: string;
  agentName: string;
  reasons: TripReason[];            // ["consecutive_failures", "no_progress", "token_velocity"]
  consecutiveFailures: number;
  consecutiveNoProgress: number;
  circuitState: "open";
}

// plugin.circuit_breaker.reset
{
  agentId: string;
  agentName: string;
  previousState: "open" | "half-open";
  resetBy: "successful_run" | "manual_resume" | "half_open_trial";
  circuitState: "closed";
}
```

## Metrics Schema

| Metric Name | Type | Tags | Description |
|------------|------|------|-------------|
| `circuit_breaker.tripped` | counter | — | Total circuit trips |
| `circuit_breaker.tripped.consecutive_failures` | counter | — | Trips from failure detection |
| `circuit_breaker.tripped.no_progress` | counter | — | Trips from no-progress detection |
| `circuit_breaker.tripped.token_velocity` | counter | — | Trips from velocity detection |
| `circuit_breaker.reset` | counter | — | Total circuit resets |
| `circuit_breaker.half_open` | counter | — | Half-open recovery attempts |

## Upstream PRs Needed

1. **Event payload enrichment** — Add `resultJson` to the `agent.run.finished` domain event payload in `heartbeat.ts` (line ~1461). Small change: add `resultJson: adapterResult.resultJson ?? null` to the payload object. Benefits all plugin consumers, not just the circuit breaker.

2. **Catastrophic failure domain events** (follow-up) — Add `emitDomainEvent` to the catch block in `heartbeat.ts` (line ~1517) so adapter crashes are visible to plugins.

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-03-09-circuit-breaker-plugin-brainstorm.md`
- agents.pause plan: `docs/plans/2026-03-09-feat-plugin-sdk-agents-pause-resume-plan.md`
- Plugin SDK types: `packages/plugins/sdk/src/types.ts`
- Discord notifier example: `packages/plugins/examples/plugin-discord-notifier-example/`
- Webhook notifier example: `packages/plugins/examples/plugin-webhook-notifier-example/`
- Domain event emission: `server/src/services/heartbeat.ts:1449-1470`
- Plugin event bus: `server/src/services/plugin-event-bus.ts`
- Plugin state store: `server/src/services/plugin-state-store.ts`
- Agent types: `packages/shared/src/types/agent.ts`
- Capabilities: `packages/shared/src/constants.ts:331-372`

### Related Issues & PRs
- Issue #390: Agent circuit breaker proposal
- Issue #373: Agents burning tokens overnight with no tasks
- PR #391: Server-side circuit breaker (competing approach, flagged 2/5)
- PR #396: Plugin SDK
- PR #398: Webhook + Discord notifier plugins
- PR #403: `agents.pause` + `agents.resume` SDK capability
