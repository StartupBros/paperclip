# Decision Log / ADR Plugin Brainstorm

**Date:** 2026-03-09
**Issue:** #228 — Feature: Decision & Architecture Documentation System for Agents
**Status:** Ready for planning

## What We're Building

A plugin that gives agents persistent institutional memory through structured decision records (ADRs). Agents explicitly log decisions as they work via a `log_decision` tool, and can query past decisions via a `query_decisions` tool to avoid repeated reasoning. Humans review decision history through a "Decisions" tab on agent detail pages.

This solves the core problem from #228: when an agent makes a 20-file refactor at 3am, you need to know not just what changed but *why* — and the agent needs to remember what it decided last time.

## Why This Approach

**Agent tool as primary capture** — explicit, reliable, zero parsing heuristics. Agents call `log_decision()` when they make a significant choice. No fragile output parsing.

**Read-back via `query_decisions` tool** — this is what makes it *institutional memory* vs just a log. Agents can check past decisions before making new ones, directly addressing the "repeated reasoning" problem.

**Entity system for storage** — `ctx.entities.upsert/list` is purpose-built for this. Structured records with built-in title/status fields, JSON data blob for the ADR content, scoped to agents. Zero schema migrations needed.

**Event subscription for activity logging** — `agent.run.finished` triggers an activity summary of decisions captured during the run. Lightweight, non-invasive.

**Broadest SDK surface area** — no existing example plugin combines tools + events + entities + UI tabs + data/action bridge. This exercises every major capability in one focused plugin.

## Key Decisions

1. **Trigger: Agent tool (explicit) + event subscription (activity logging)** — agents call `log_decision()` explicitly. `agent.run.finished` event logs activity summary. No auto-extraction from run output.

2. **Schema: Focused ADR** — every field earns its place:
   - `entity.title` — decision title (built-in listing/sorting)
   - `entity.status` — `"accepted"` | `"superseded"` (built-in filtering)
   - `data.decision` — what was decided
   - `data.rationale` — why (most valuable field)
   - `data.alternatives[]` — `{name, reason_rejected}`
   - `data.confidence` — `"low"` | `"medium"` | `"high"`
   - `data.category` — `"architecture"` | `"design"` | `"dependency"` | `"approach"`
   - `data.tags[]` — free-form string array
   - `data.supersedes_id` — links decision chains

3. **Scope: Agent-only** — decisions scoped to agents via `scopeKind: "agent"`. Can extend to issues/projects later without breaking changes.

4. **UI: Read + filter** — list decisions with category/confidence/status filters, expandable detail cards. Demonstrates the data bridge. No write-back actions from UI (YAGNI for v1).

5. **Two agent tools** — `log_decision` (write) and `query_decisions` (read). The read-back is what makes this institutional memory, not just a log.

## SDK Capabilities Used

| Capability | Usage |
|-----------|-------|
| `agent.tools.register` | `log_decision` + `query_decisions` tools |
| `events.subscribe` | `agent.run.finished` for activity summary |
| `ctx.entities.upsert/list` | Persist/query decision records (no capability needed) |
| `ctx.data.register` | Bridge for UI to query decisions |
| `ctx.activity.log` | Audit trail entries |
| `ui.detailTab.register` | "Decisions" tab on agent detail pages |

## Plugin Structure

```
packages/plugins/examples/plugin-decision-log-example/
  src/
    manifest.ts       — Plugin metadata, capabilities, UI slots, tool declarations
    worker.ts         — setup(): register tools, events, data handlers
    worker.test.ts    — Test suite using SDK test harness
    ui/index.tsx      — DecisionLogTab component
  index.ts
  package.json
  tsconfig.json
  vite.config.ts      — UI bundle config (if needed)
```

## Open Questions

- **Decision ID format for `supersedes_id`**: use the entity UUID returned from `upsert`, or a human-friendly slug? Entity UUID is simpler and avoids naming collisions.
- **Run correlation**: should `log_decision` automatically capture the current run ID if available from the tool invocation context? Depends on what the tool handler receives.
- **Confidence as input vs computed**: should agents set confidence explicitly, or should it be inferred from the number/quality of alternatives? Explicit is KISS.

## Next Steps

Run `/workflows:plan` to generate the implementation plan.
