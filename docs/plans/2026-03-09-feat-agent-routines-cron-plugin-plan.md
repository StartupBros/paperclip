---
title: "feat: Agent Routines / Cron Plugin"
type: feat
date: 2026-03-09
issue: "#219"
brainstorm: docs/brainstorms/2026-03-09-agent-routines-plugin-brainstorm.md
---

# feat: Agent Routines / Cron Plugin (#219)

## Overview

Build `@paperclipai/plugin-agent-routines` — a plugin that lets operators define scheduled routines (cron expression + agent + prompt) so agents execute specific tasks on a recurring schedule. Also add `ctx.agents.invoke()` to the plugin SDK, bundled into PR #403.

Two work streams:
1. **SDK addition** — add `agents.invoke` capability across the 6-layer SDK pattern (PR #403)
2. **Plugin** — build the agent-routines plugin using the SDK

## Problem Statement / Motivation

- Agent routines are one of the most requested features (#219)
- No way today to run agents on a schedule with a specific prompt
- Implementing as a plugin validates the architectural decision to build platform features as plugins
- First real plugin to fully exercise `ctx.jobs.register()` scheduling
- Use cases: daily production health checks, end-of-day summaries, weekly dependency audits

## Proposed Solution

### Architecture: Single Dispatcher Job

The manifest declares **one job** — `routine-dispatcher` — on a 1-minute cron. The handler reads the routines array from config, evaluates each routine's cron expression against the current time using the existing `parseCron`/`nextCronTick` utilities, and invokes matching agents.

This avoids the static-vs-dynamic job registration problem entirely: no fixed slot limits, no SDK changes to the job system, and config changes take effect on the next tick without worker restarts.

### SDK: `ctx.agents.invoke()`

New capability `"agents.invoke"` following the 6-layer pattern, bundled into PR #403 alongside `agents.pause`/`agents.resume`.

```typescript
// PluginAgentsClient (types.ts)
invoke(agentId: string, companyId: string, opts: { prompt: string; reason?: string }): Promise<{ runId: string }>;
```

The host-side wiring calls `heartbeat.wakeup()` with `source: "automation"`, `triggerDetail: "system"`, and the prompt in `payload: { prompt }`.

### Routine Config Schema

```typescript
instanceConfigSchema: {
  type: "object",
  properties: {
    routines: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          name:           { type: "string", description: "Human-readable label" },
          cronExpression: { type: "string", description: "5-field cron (e.g. '0 9 * * 1-5')" },
          agentId:        { type: "string", description: "Target agent UUID" },
          companyId:      { type: "string", description: "Company the agent belongs to" },
          prompt:         { type: "string", description: "What the agent should do" },
          enabled:        { type: "boolean", default: true }
        },
        required: ["name", "cronExpression", "agentId", "companyId", "prompt"]
      }
    }
  }
}
```

### Wakeup Payload Contract

When invoking an agent, the plugin passes:

```typescript
await ctx.agents.invoke(routine.agentId, routine.companyId, {
  prompt: routine.prompt,
  reason: `Scheduled routine: ${routine.name}`,
});
```

Host-side translates to:

```typescript
heartbeat.wakeup(agentId, {
  source: "automation",
  triggerDetail: "system",
  reason: opts.reason,
  payload: { prompt: opts.prompt },
  requestedByActorType: "system",
  requestedByActorId: pluginId,
});
```

The agent reads the prompt from `payload.prompt` in its heartbeat context.

### Error Handling Strategy

| Error from `ctx.agents.invoke()` | Handler Action |
|---|---|
| Agent not found | Log error, continue to next routine |
| Agent paused/terminated/pending_approval | Log warning, continue |
| Wakeup skipped (policy rejection) | Log warning, continue |
| Unexpected error | Log error, continue |

The dispatcher job itself never throws — individual routine failures don't prevent other routines from firing. The job run always succeeds. Errors are tracked via activity log and metrics.

## Implementation

### Work Stream 1: SDK `agents.invoke` (PR #403)

#### Layer 1: Shared Constants

**File:** `packages/shared/src/constants.ts` (after `"agents.resume"` at line ~348)

```typescript
"agents.pause",
"agents.resume",
"agents.invoke",    // NEW
```

#### Layer 2: SDK Types

**File:** `packages/plugins/sdk/src/types.ts` (inside `PluginAgentsClient`, after `resume`)

```typescript
/**
 * Invoke (wake up) an agent with a prompt payload.
 * The agent receives the prompt in its heartbeat context.
 * Throws if agent is paused, terminated, pending_approval, or not found.
 * Requires `agents.invoke`.
 */
invoke(agentId: string, companyId: string, opts: { prompt: string; reason?: string }): Promise<{ runId: string }>;
```

#### Layer 3: Protocol

**File:** `packages/plugins/sdk/src/protocol.ts` (after `"agents.resume"` entry)

```typescript
"agents.invoke": [
  params: { agentId: string; companyId: string; prompt: string; reason?: string },
  result: { runId: string },
];
```

#### Layer 4: Host-Client-Factory

**File:** `packages/plugins/sdk/src/host-client-factory.ts`

4a. `HostServices.agents` interface (after `resume`):
```typescript
invoke(params: { agentId: string; companyId: string; prompt: string; reason?: string }): Promise<{ runId: string }>;
```

4b. `METHOD_CAPABILITY_MAP` (after `"agents.resume"`):
```typescript
"agents.invoke": "agents.invoke",
```

4c. Handler in `createHostClientHandlers()` (after `"agents.resume"` handler):
```typescript
"agents.invoke": gated("agents.invoke", async (params) => {
  return services.agents.invoke(params);
}),
```

#### Layer 5: Worker RPC Host

**File:** `packages/plugins/sdk/src/worker-rpc-host.ts` (after `resume` in `ctx.agents`)

```typescript
async invoke(agentId: string, companyId: string, opts: { prompt: string; reason?: string }) {
  return callHost("agents.invoke", { agentId, companyId, prompt: opts.prompt, reason: opts.reason }) as any;
},
```

#### Layer 6: Testing Harness

**File:** `packages/plugins/sdk/src/testing.ts` (after `resume` mock)

```typescript
async invoke(agentId, companyId, opts) {
  requireCapability(manifest, capabilitySet, "agents.invoke");
  const cid = requireCompanyId(companyId);
  const agent = agents.get(agentId);
  if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
  if (agent!.status === "paused" || agent!.status === "terminated" || agent!.status === "pending_approval") {
    throw new Error(`Agent is not invokable in its current state: ${agent!.status}`);
  }
  return { runId: crypto.randomUUID() };
},
```

#### Layer 7: Server-Side Host Services

**File:** `server/src/services/plugin-host-services.ts` (inside `agents:` block, after `get`)

```typescript
async invoke(params) {
  const companyId = ensureCompanyId(params.companyId);
  const agent = await agents.getById(params.agentId);
  requireInCompany("Agent", agent, companyId);
  const run = await heartbeat.wakeup(params.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: params.reason ?? null,
    payload: { prompt: params.prompt },
    requestedByActorType: "system",
    requestedByActorId: pluginId,
  });
  if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");
  return { runId: run.id };
},
```

Also wire up `pause` and `resume` in this file (currently only `list`/`get` exist at line 324-336).

### Work Stream 2: Agent Routines Plugin

#### Plugin File Structure

```
packages/plugins/examples/plugin-agent-routines/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts            # re-exports manifest + worker
    manifest.ts         # manifest with jobs, config schema, capabilities
    worker.ts           # definePlugin({ setup(ctx) { ... } })
    cron-match.ts       # shouldFireAt(cronExpression, date) helper
```

#### `package.json`

```json
{
  "name": "@paperclipai/plugin-agent-routines",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": { ".": "./src/index.ts" },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*"
  }
}
```

#### `src/manifest.ts`

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.agent-routines",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Agent Routines",
  description: "Run agents on cron schedules with specific prompts.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "agents.invoke",
    "agents.read",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      routines: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            name:           { type: "string" },
            cronExpression: { type: "string" },
            agentId:        { type: "string" },
            companyId:      { type: "string" },
            prompt:         { type: "string" },
            enabled:        { type: "boolean", default: true },
          },
          required: ["name", "cronExpression", "agentId", "companyId", "prompt"],
        },
      },
    },
  },
  jobs: [
    {
      jobKey: "routine-dispatcher",
      displayName: "Routine Dispatcher",
      description: "Checks enabled routines every minute and invokes matching agents.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
```

#### `src/cron-match.ts`

A thin helper that checks whether a cron expression matches a given minute (truncated to the minute boundary). Uses the same 5-field cron format as `server/src/services/cron.ts`.

```typescript
/**
 * Check if a cron expression matches the given date (minute-level granularity).
 * Re-implements the cron matching logic from server/src/services/cron.ts
 * since the plugin worker cannot import server modules.
 */
export function shouldFireAt(cronExpression: string, date: Date): boolean {
  const parsed = parseCron(cronExpression);
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  return (
    parsed.minutes.includes(minute) &&
    parsed.hours.includes(hour) &&
    parsed.daysOfMonth.includes(dayOfMonth) &&
    parsed.months.includes(month) &&
    parsed.daysOfWeek.includes(dayOfWeek)
  );
}
```

The `parseCron` function is duplicated from `server/src/services/cron.ts` (it's ~150 lines of pure parsing logic with no server dependencies). Alternatively, extract the cron parser into `packages/shared` to share between server and plugin workers.

#### `src/worker.ts`

```typescript
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { shouldFireAt, validateCronExpression } from "./cron-match.js";

interface Routine {
  name: string;
  cronExpression: string;
  agentId: string;
  companyId: string;
  prompt: string;
  enabled?: boolean;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("routine-dispatcher", async (job) => {
      const config = ctx.config.get() as { routines?: Routine[] };
      const routines = config?.routines ?? [];
      const now = new Date(job.scheduledAt);

      for (const routine of routines) {
        if (routine.enabled === false) continue;
        if (!shouldFireAt(routine.cronExpression, now)) continue;

        try {
          const result = await ctx.agents.invoke(routine.agentId, routine.companyId, {
            prompt: routine.prompt,
            reason: `Scheduled routine: ${routine.name}`,
          });

          await ctx.activity.log({
            companyId: routine.companyId,
            message: `Routine "${routine.name}" invoked agent ${routine.agentId} (run: ${result.runId})`,
            entityType: "agent",
            entityId: routine.agentId,
          });

          await ctx.metrics.write("routine_invocation_total", 1, {
            routine: routine.name,
            status: "success",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`Routine "${routine.name}" failed`, { error: message });

          await ctx.activity.log({
            companyId: routine.companyId,
            message: `Routine "${routine.name}" failed to invoke agent ${routine.agentId}: ${message}`,
            entityType: "agent",
            entityId: routine.agentId,
          });

          await ctx.metrics.write("routine_invocation_total", 1, {
            routine: routine.name,
            status: "error",
          });
        }
      }
    });
  },

  async onValidateConfig(config) {
    const routines = (config as { routines?: Routine[] })?.routines;
    if (!routines || !Array.isArray(routines)) return { ok: true };

    const errors: string[] = [];
    for (let i = 0; i < routines.length; i++) {
      const r = routines[i]!;
      const cronError = validateCronExpression(r.cronExpression);
      if (cronError) {
        errors.push(`Routine "${r.name ?? i}": invalid cron expression — ${cronError}`);
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Agent routines plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

#### `src/index.ts`

```typescript
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./worker.js";
```

## Acceptance Criteria

### Functional Requirements

- [ ] `ctx.agents.invoke(agentId, companyId, { prompt, reason? })` works end-to-end
- [ ] Plugin reads routines from instance config
- [ ] Plugin validates cron expressions in `onValidateConfig`
- [ ] Dispatcher job fires every minute and evaluates each enabled routine's cron
- [ ] Matching routines invoke their target agent with the prompt as wakeup payload
- [ ] Activity log entries created for every invocation (success and failure)
- [ ] Metrics written for invocation counts with status tags
- [ ] Disabled routines (`enabled: false`) are skipped
- [ ] Agent status guards enforced: paused/terminated/pending_approval agents produce logged errors, not crashes
- [ ] Invalid cron expressions rejected at config validation time

### Testing Requirements

- [ ] SDK tests: `agents.invoke` capability gating (requires capability, rejects without)
- [ ] SDK tests: `agents.invoke` status guards (rejects paused, terminated, pending_approval)
- [ ] SDK tests: `agents.invoke` company scoping (rejects agents from wrong company)
- [ ] Plugin tests: dispatcher fires matching routines, skips non-matching
- [ ] Plugin tests: disabled routines skipped
- [ ] Plugin tests: error in one routine doesn't block others
- [ ] Plugin tests: config validation rejects invalid cron expressions
- [ ] Plugin tests: config validation accepts valid cron expressions

## Dependencies & Risks

- **Dependency:** PR #403 must land with `agents.invoke` before the plugin can be merged
- **Dependency:** Server-side host services wiring for `agents.invoke` (also in PR #403)
- **Risk:** Cron parser duplication between server and plugin worker — mitigate by extracting to `packages/shared` if the plugin worker can import from there
- **Risk:** Agent heartbeat policy (`wakeOnDemand: false`) silently rejects automation wakeups — mitigate by throwing from host services rather than returning null, so the plugin gets a clear error

## Open Items (v2)

- UI dashboard showing routine status, last/next run times, recent results
- Timezone support for cron expressions (currently UTC)
- Plugin events (`routine.fired`, `routine.failed`) for other plugins to react
- Per-routine execution history stored in plugin state
- Agent validation at config time (verify agentId exists)

## References

- Brainstorm: `docs/brainstorms/2026-03-09-agent-routines-plugin-brainstorm.md`
- Scheduled job example: `packages/plugins/examples/plugin-scheduled-job-example/`
- Plugin SDK types: `packages/plugins/sdk/src/types.ts:836-843`
- Heartbeat wakeup: `server/src/services/heartbeat.ts:1735-1790`
- Host services bridge: `server/src/services/plugin-host-services.ts:324-336`
- Cron parser: `server/src/services/cron.ts`
- agents.pause/resume plan: `docs/plans/2026-03-09-feat-plugin-sdk-agents-pause-resume-plan.md`
