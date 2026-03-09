---
title: "feat: Decision Log / ADR Plugin"
type: feat
date: 2026-03-09
issue: "#228"
brainstorm: docs/brainstorms/2026-03-09-decision-log-plugin-brainstorm.md
---

# feat: Decision Log / ADR Plugin

## Overview

A plugin that gives agents persistent institutional memory through structured decision records (ADRs). Agents explicitly log decisions via a `log_decision` tool and query past decisions via `query_decisions` to avoid repeated reasoning. Humans review decision history through a "Decisions" tab on agent detail pages.

This exercises the full plugin SDK surface area — agent tools, event subscription, entity storage, data/action bridge, UI detail tabs, and activity logging — in a single focused plugin.

## Problem Statement

From issue #228: agents lose institutional memory between runs, forcing repeated reasoning and increasing errors. When an agent makes a 20-file refactor at 3am, the team needs to know not just what changed but *why*. Currently, Paperclip records tasks and conversations but not structured decision artifacts.

## Proposed Solution

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Agent Runtime                                           │
│  ┌─────────────┐  ┌──────────────────┐                  │
│  │ log_decision │  │ query_decisions  │  (agent tools)   │
│  └──────┬──────┘  └────────┬─────────┘                  │
└─────────┼──────────────────┼────────────────────────────┘
          │                  │
          ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│  Plugin Worker (setup)                                   │
│                                                          │
│  ctx.tools.register("log_decision", ...)                 │
│  ctx.tools.register("query_decisions", ...)              │
│  ctx.events.on("agent.run.finished", ...)                │
│  ctx.data.register("decisions-list", ...)                │
│                                                          │
│  Storage: ctx.entities.upsert/list                       │
│  Counter: ctx.state (run-scoped decision count)          │
│  Audit:   ctx.activity.log                               │
└─────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│  UI Detail Tab: "Decisions" (agent pages)                │
│                                                          │
│  usePluginData("decisions-list", { agentId, filters })   │
│  ┌─────────────────────────────────────────────────┐     │
│  │ Filter bar: category | confidence | status       │     │
│  │ Search: text input                               │     │
│  ├─────────────────────────────────────────────────┤     │
│  │ Decision card (expandable)                       │     │
│  │   Title · Category badge · Confidence badge      │     │
│  │   ▶ Decision · Rationale · Alternatives · Tags   │     │
│  └─────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### Entity Schema

Stored via `ctx.entities.upsert` with `entityType: "decision-record"`:

| Field | Location | Type | Description |
|-------|----------|------|-------------|
| title | `entity.title` | string | Decision title (required, max 200 chars) |
| status | `entity.status` | `"accepted"` \| `"superseded"` | Decision lifecycle state |
| externalId | `entity.externalId` | string (UUID) | Stable unique ID via `crypto.randomUUID()` |
| scopeKind | `entity.scopeKind` | `"agent"` | Always agent-scoped |
| scopeId | `entity.scopeId` | string (UUID) | Agent's UUID |
| decision | `data.decision` | string | What was decided (required, max 5000 chars) |
| rationale | `data.rationale` | string | Why this decision was made (required, max 5000 chars) |
| alternatives | `data.alternatives` | `Array<{name: string, reason_rejected: string}>` | Options considered and why rejected |
| confidence | `data.confidence` | `"low"` \| `"medium"` \| `"high"` | Agent's confidence level |
| category | `data.category` | `"architecture"` \| `"design"` \| `"dependency"` \| `"approach"` | Decision classification |
| tags | `data.tags` | `string[]` | Free-form tags (deduplicated, lowercased) |
| supersedes_id | `data.supersedes_id` | string \| null | `externalId` of the superseded decision |
| run_id | `data.run_id` | string | Run UUID from `ToolRunContext.runId` (auto-captured) |

### SDK Capabilities

| Capability | Usage |
|-----------|-------|
| `agent.tools.register` | `log_decision` + `query_decisions` |
| `events.subscribe` | `agent.run.finished` activity summary |
| `activity.log.write` | Audit trail entries |
| `ui.detailTab.register` | "Decisions" tab on agent detail pages |
| `plugin.state.read` | Read run-scoped decision counter |
| `plugin.state.write` | Increment run-scoped decision counter |
| *(no capability needed)* | `ctx.entities.upsert/list` |

## Technical Considerations

### Prerequisite: Fix `listEntities` Scope Filtering

**Critical platform gap.** The server's `listEntities` implementation (`server/src/services/plugin-registry.ts:656-668`) does not filter by `scopeKind` or `scopeId`, despite the SDK's `PluginEntityQuery` type including these fields. The shared `PluginEntityQuery` type (`packages/shared/src/types/plugin.ts:410-419`) is also missing these fields.

Without this fix, `ctx.entities.list({ scopeKind: "agent", scopeId: agentId })` returns ALL entities across ALL agents.

**Fix required:**
1. Add `scopeKind?: PluginStateScopeKind` and `scopeId?: string` to `PluginEntityQuery` in `packages/shared/src/types/plugin.ts`
2. Add scope filtering conditions to `listEntities` in `server/src/services/plugin-registry.ts`

### Supersession Strategy

- `supersedes_id` references the target decision's `externalId` (not internal UUID)
- Lookup via `ctx.entities.list({ entityType: "decision-record", externalId: supersedes_id })`
- Validation: must exist and belong to the same agent; reject otherwise
- The superseded decision's `status` is updated to `"superseded"` via `ctx.entities.upsert` with matching `externalId`
- No cycle detection in v1 (YAGNI — cycles are extremely unlikely with agent-generated IDs)

### Run Decision Counter

The `agent.run.finished` handler needs to know how many decisions were logged during a run without scanning all entities. Solution: use `ctx.state` with `scopeKind: "run"`, `scopeId: runId`, `stateKey: "decision-count"` as a counter that `log_decision` increments. The event handler reads this counter.

### Client-Side Filtering

The entity list API only supports server-side filtering by `entityType`, `scopeKind`, `scopeId`, and `externalId`. Category, tags, confidence, and search text require client-side filtering in the worker's data handler. For v1, this is acceptable — agents are unlikely to accumulate thousands of decisions. The data handler fetches all decisions for the agent and filters in-memory.

### Ordering

Entity list API returns `createdAt ASC` by default. The data handler reverses to newest-first for both UI and `query_decisions` tool results.

## Implementation Phases

### Phase 1: Platform Fix (prerequisite)

**Files to modify:**

- `packages/shared/src/types/plugin.ts` — Add `scopeKind` and `scopeId` to `PluginEntityQuery`
- `server/src/services/plugin-registry.ts` — Add scope filter conditions to `listEntities`

**Acceptance criteria:**
- [ ] `ctx.entities.list({ scopeKind: "agent", scopeId: "uuid" })` returns only entities scoped to that agent
- [ ] Existing plugins unaffected (scope filters are optional)

### Phase 2: Plugin Scaffold + Worker

**Files to create:**

```
packages/plugins/examples/plugin-decision-log-example/
  package.json
  tsconfig.json
  src/
    index.ts
    manifest.ts
    worker.ts
    worker.test.ts
```

#### `manifest.ts`

```typescript
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.decision-log",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Decision Log",
  description: "Gives agents persistent institutional memory through structured decision records.",
  author: "Paperclip",
  categories: ["ui", "automation"],
  capabilities: [
    "agent.tools.register",
    "events.subscribe",
    "activity.log.write",
    "ui.detailTab.register",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  tools: [
    {
      name: "log_decision",
      displayName: "Log Decision",
      description: "Record a structured decision with rationale, alternatives, and confidence level. Use when making significant architectural, design, dependency, or approach choices.",
      parametersSchema: {
        type: "object",
        required: ["title", "decision", "rationale", "confidence", "category"],
        properties: {
          title: { type: "string", maxLength: 200, description: "Short decision title" },
          decision: { type: "string", maxLength: 5000, description: "What was decided" },
          rationale: { type: "string", maxLength: 5000, description: "Why this decision was made" },
          alternatives: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "reason_rejected"],
              properties: {
                name: { type: "string" },
                reason_rejected: { type: "string" },
              },
            },
            description: "Alternatives considered and why they were rejected",
          },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          category: { type: "string", enum: ["architecture", "design", "dependency", "approach"] },
          tags: { type: "array", items: { type: "string" }, description: "Free-form tags" },
          supersedes_id: { type: "string", description: "externalId of the decision this supersedes" },
        },
      },
    },
    {
      name: "query_decisions",
      displayName: "Query Past Decisions",
      description: "Look up past decisions to avoid repeated reasoning. Returns decisions scoped to the calling agent.",
      parametersSchema: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["architecture", "design", "dependency", "approach"] },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["accepted", "superseded"], default: "accepted" },
          limit: { type: "number", minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "decisions-tab",
        displayName: "Decisions",
        exportName: "DecisionsTab",
        entityTypes: ["agent"],
      },
    ],
  },
};
```

#### `worker.ts` — Key Logic

```typescript
// log_decision tool handler
ctx.tools.register("log_decision", { ... }, async (params, runCtx) => {
  const { title, decision, rationale, alternatives, confidence, category, tags, supersedes_id } = params;

  // Validate supersedes_id if provided
  if (supersedes_id) {
    const existing = await ctx.entities.list({
      entityType: "decision-record",
      scopeKind: "agent",
      scopeId: runCtx.agentId,
      externalId: supersedes_id,
    });
    if (existing.length === 0) {
      return { error: `Decision with externalId "${supersedes_id}" not found for this agent.` };
    }
    // Mark the old decision as superseded
    await ctx.entities.upsert({
      entityType: "decision-record",
      scopeKind: "agent",
      scopeId: runCtx.agentId,
      externalId: supersedes_id,
      status: "superseded",
      data: existing[0].data,
    });
  }

  const externalId = crypto.randomUUID();
  const normalizedTags = [...new Set((tags ?? []).map((t: string) => t.toLowerCase()))];

  const record = await ctx.entities.upsert({
    entityType: "decision-record",
    scopeKind: "agent",
    scopeId: runCtx.agentId,
    externalId,
    title,
    status: "accepted",
    data: { decision, rationale, alternatives: alternatives ?? [], confidence, category, tags: normalizedTags, supersedes_id: supersedes_id ?? null, run_id: runCtx.runId },
  });

  // Increment run-scoped decision counter
  const counterKey = { scopeKind: "run" as const, scopeId: runCtx.runId, stateKey: "decision-count" };
  const current = Number(await ctx.state.get(counterKey)) || 0;
  await ctx.state.set(counterKey, String(current + 1));

  await ctx.activity.log({
    companyId: runCtx.companyId,
    message: `Decision recorded: ${title}`,
    entityType: "agent",
    entityId: runCtx.agentId,
  });

  return { content: `Decision "${title}" recorded (${externalId}).`, data: { id: record.id, externalId } };
});

// query_decisions tool handler
ctx.tools.register("query_decisions", { ... }, async (params, runCtx) => {
  const { category, tags, status, limit } = params;
  const all = await ctx.entities.list({
    entityType: "decision-record",
    scopeKind: "agent",
    scopeId: runCtx.agentId,
    limit: 100,
  });

  let filtered = status ? all.filter(e => e.status === status) : all.filter(e => e.status === "accepted");
  if (category) filtered = filtered.filter(e => e.data.category === category);
  if (tags?.length) filtered = filtered.filter(e => tags.some((t: string) => (e.data.tags as string[])?.includes(t.toLowerCase())));

  const results = filtered.slice(0, limit ?? 20).reverse(); // newest first
  return {
    content: `Found ${results.length} decision(s).`,
    data: results.map(r => ({ externalId: r.externalId, title: r.title, status: r.status, ...r.data })),
  };
});

// agent.run.finished event handler
ctx.events.on("agent.run.finished", async (event) => {
  const agentId = event.payload?.agentId ?? event.entityId;
  const runId = event.payload?.runId;
  if (!agentId || !runId) return;

  const counterKey = { scopeKind: "run" as const, scopeId: runId, stateKey: "decision-count" };
  const count = Number(await ctx.state.get(counterKey)) || 0;
  if (count === 0) return; // don't log noise

  await ctx.activity.log({
    companyId: event.companyId,
    message: `${count} decision(s) recorded during this run.`,
    entityType: "agent",
    entityId: agentId,
  });
});

// Data handler for UI
ctx.data.register("decisions-list", async (params) => {
  const { agentId, category, confidence, status, search } = params;
  if (!agentId) return { decisions: [], total: 0 };

  const all = await ctx.entities.list({
    entityType: "decision-record",
    scopeKind: "agent",
    scopeId: agentId as string,
    limit: 200,
  });

  let filtered = all;
  if (status) filtered = filtered.filter(e => e.status === status);
  if (category) filtered = filtered.filter(e => e.data.category === category);
  if (confidence) filtered = filtered.filter(e => e.data.confidence === confidence);
  if (search) {
    const q = (search as string).toLowerCase();
    filtered = filtered.filter(e =>
      (e.title ?? "").toLowerCase().includes(q) ||
      String(e.data.decision ?? "").toLowerCase().includes(q) ||
      String(e.data.rationale ?? "").toLowerCase().includes(q)
    );
  }

  const decisions = filtered.reverse(); // newest first
  return { decisions, total: decisions.length };
});
```

**Acceptance criteria:**
- [ ] `log_decision` tool creates entity records with correct schema
- [ ] `log_decision` with `supersedes_id` marks old decision as superseded
- [ ] `log_decision` with invalid `supersedes_id` returns error
- [ ] `query_decisions` returns only calling agent's decisions
- [ ] `query_decisions` filters by category, tags, status
- [ ] `query_decisions` defaults to accepted-only
- [ ] `agent.run.finished` logs activity only when decisions > 0
- [ ] Tags are deduplicated and lowercased
- [ ] `run_id` is auto-captured from ToolRunContext

### Phase 3: Tests

**File:** `src/worker.test.ts`

Test cases using `createTestHarness`:

- [ ] `log_decision` creates entity with all fields
- [ ] `log_decision` generates unique externalId per call
- [ ] `log_decision` normalizes tags (dedup + lowercase)
- [ ] `log_decision` increments run-scoped decision counter
- [ ] `log_decision` logs activity
- [ ] `log_decision` with `supersedes_id` updates old decision status
- [ ] `log_decision` with invalid `supersedes_id` returns error
- [ ] `query_decisions` returns empty list when no decisions exist
- [ ] `query_decisions` filters by category
- [ ] `query_decisions` filters by tags (any match)
- [ ] `query_decisions` filters by status (defaults to "accepted")
- [ ] `query_decisions` respects limit
- [ ] `query_decisions` returns newest first
- [ ] `agent.run.finished` skips activity log when 0 decisions
- [ ] `agent.run.finished` logs count when decisions > 0
- [ ] `decisions-list` data handler returns filtered results
- [ ] `decisions-list` search is case-insensitive on title/decision/rationale
- [ ] `onHealth` returns ok

### Phase 4: UI Tab

**File:** `src/ui/index.tsx`

Component: `DecisionsTab` receiving `PluginDetailTabProps`.

- [ ] Calls `usePluginData("decisions-list", { agentId: context.entityId })` for data
- [ ] Filter bar: dropdowns for category, confidence, status; text input for search
- [ ] Decision cards: title, category badge (`StatusBadge`), confidence badge, created date
- [ ] Expandable detail: decision text, rationale, alternatives list, tags, supersession info
- [ ] Empty state: "No decisions recorded yet" message
- [ ] Loading state: `Spinner` component from SDK
- [ ] Error state: inline error message
- [ ] Styling: Tailwind utilities with host design tokens

### Phase 5: Build Config + Integration

**Files to create/modify:**

- `package.json` — dependencies, scripts, paperclipPlugin field
- `tsconfig.json` — extends root config

**Acceptance criteria:**
- [ ] `pnpm build --filter plugin-decision-log-example` succeeds
- [ ] `pnpm test --filter plugin-decision-log-example` passes
- [ ] Plugin installable via `pnpm paperclipai plugin install`

## Acceptance Criteria

### Functional Requirements

- [ ] Agents can log structured decisions with title, rationale, alternatives, confidence, category
- [ ] Agents can query their own past decisions with filters
- [ ] Supersession chain works: new decision marks old as superseded
- [ ] Activity log shows decision count per run (only when > 0)
- [ ] UI tab on agent detail pages shows decision history
- [ ] UI supports filtering by category, confidence, status, and text search
- [ ] Decisions are scoped to agents (no cross-agent leakage)

### Non-Functional Requirements

- [ ] All tests pass via `createTestHarness`
- [ ] TypeScript strict mode, no `any` types
- [ ] Follows existing plugin patterns (manifest/worker/index/ui structure)
- [ ] No external dependencies beyond SDK

### Quality Gates

- [ ] Platform fix for `listEntities` scope filtering included
- [ ] Test coverage for all tool handlers, event handler, data handler
- [ ] UI handles empty, loading, and error states

## Dependencies & Prerequisites

- **Platform fix:** `listEntities` must support `scopeKind`/`scopeId` filtering (Phase 1)
- **Plugin SDK:** `@paperclipai/plugin-sdk` (workspace dependency)
- **No external deps:** Pure SDK usage, no third-party libraries

## References

### Internal

- Brainstorm: `docs/brainstorms/2026-03-09-decision-log-plugin-brainstorm.md`
- Entity tabs example: `packages/plugins/examples/plugin-entity-tabs-example/`
- Tools example: `packages/plugins/examples/plugin-tools-example/`
- File browser example (data bridge): `packages/plugins/examples/plugin-file-browser-example/`
- Webhook notifier tests: `packages/plugins/examples/plugin-webhook-notifier-example/src/worker.test.ts`
- SDK types: `packages/plugins/sdk/src/types.ts` (ToolRunContext, PluginEntityUpsert, etc.)
- SDK UI hooks: `packages/plugins/sdk/src/ui/hooks.ts`
- SDK UI components: `packages/plugins/sdk/src/ui/components.ts`
- Server listEntities: `server/src/services/plugin-registry.ts:656-668`
- Shared PluginEntityQuery: `packages/shared/src/types/plugin.ts:410-419`

### External

- Issue #228: Feature: Decision & Architecture Documentation System for Agents
