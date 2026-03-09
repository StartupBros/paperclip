# Brainstorm: Summarize Plugin — Daily/Weekly Agent Fleet Digests

**Date:** 2026-03-09
**Status:** Ready for planning

## What We're Building

A "Summarize" plugin that generates daily and weekly digest reports of agent fleet activity for team leads. Combines event accumulation with SDK data pulls to produce comprehensive digests covering fleet health, task throughput, cost spend, anomaly detection, and per-agent breakdowns. Delivers via in-app dashboard widget and optional webhook.

This is the **first plugin to combine scheduled jobs + event accumulation + domain data reads + dashboard widgets** — a showcase of the SDK's full capability surface.

## Why This Approach

- **Hybrid architecture (event accumulation + scheduled pulls)**: Event subscriptions track counts that point-in-time snapshots miss (runs completed today, issues resolved between digest runs). SDK client pulls provide live fleet state. Together they give the most accurate picture.
- **Digest-first delivery**: The plugin focuses on data aggregation and formatting. An in-app widget via `ctx.data.register` gives instant access. A simple webhook config handles outbound delivery without duplicating the work already done in Discord/Slack/Email notifier plugins.
- **SDK-native data access**: Depends on extending PR #403 to add `costs.read` and `activity.read` SDK capabilities (following the established 6-layer pattern). This keeps the plugin clean — no REST API backdoors or fragile internal endpoint calls.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Target audience** | Team leads / managers | Focus on fleet health, throughput, failure rates. Not per-developer views. |
| **Delivery** | Dashboard widget + webhook | Widget via `ctx.data.register` for in-app. Webhook via `ctx.http.fetch` for outbound. Avoids duplicating notifier plugin delivery logic. |
| **Cost data** | SDK client (costs.read) | Extend PR #403 to add `costs.read` capability to the SDK. Clean, first-class data access. |
| **Activity data** | SDK client (activity.read) | Same — extend PR #403 with `activity.read`. |
| **Schedule** | Daily + Weekly | Daily at configurable hour (default 8am UTC). Weekly on configurable day (default Monday). Weekly includes 7-day trend data. |
| **Data architecture** | Hybrid: events + pulls | Subscribe to `agent.run.*`, `cost_event.created`, `issue.*`, `approval.*` events → accumulate counters in `ctx.state`. Scheduled jobs merge accumulated state with live SDK pulls. |
| **Anomaly detection** | Rolling 7-day average comparison | Track daily metrics in state, compare current day to rolling average. Flag: high failure rates, cost spikes, stale tasks. |
| **Per-agent breakdown** | Include | Per-agent rows with run counts, costs, status. Team leads need this for fleet management. |

## Digest Content Structure

### Fleet Overview
- Agent counts by status (active, running, paused, error)
- Runs completed / failed / cancelled (accumulated from events)
- Issues created / resolved (accumulated from events)
- Cost: spend vs budget, utilization % (from `costs.read`)
- Pending approvals count

### Anomaly Highlights
- Agents with failure rate above threshold
- Cost spikes vs 7-day rolling average
- Stale tasks count
- Agents stuck in error state

### Per-Agent Breakdown
- Agent name and current status
- Run counts (completed, failed)
- Cost (tokens, cents)
- Last activity timestamp

## SDK Prerequisites

Extend PR #403 to add two new read capabilities following the 6-layer pattern:

1. **`costs.read`** → `ctx.costs.summary(companyId)` returns `CostSummary`, `ctx.costs.byAgent(companyId)` returns `CostByAgent[]`
2. **`activity.read`** → `ctx.activity.list(companyId, filters?)` returns `ActivityEvent[]`

Types already exist in `packages/shared/src/types/cost.ts` and `activity.ts`. Capability strings already exist in `packages/shared/src/constants.ts`. Only need: types re-export, protocol methods, host-client-factory handlers, worker-rpc-host context, and testing mocks.

## Plugin Capabilities Required

```
events.subscribe, jobs.schedule, agents.read, issues.read, goals.read,
companies.read, projects.read, costs.read, activity.read,
plugin.state.read, plugin.state.write, http.outbound, secrets.read-ref,
activity.log.write, metrics.write
```

## Config Schema

- `webhookSecretRef` (string, optional) — webhook URL for digest delivery
- `dailyHour` (number, default 8) — hour of day for daily digest (UTC)
- `weeklyDay` (number, default 1) — day of week for weekly digest (0=Sun, 1=Mon)
- `timezone` (string, default "UTC") — for schedule interpretation
- `anomalyThresholds` (object, optional) — override default thresholds for anomaly detection

## Open Questions

- Should the widget support filtering by project or show company-wide only? (Lean: company-wide for MVP)
- Should the weekly digest include a comparison to the previous week? (Lean: yes, if data exists in state)

## Context

- Motivating data: ~11K downloads on npm for similar summarization tools
- Prerequisite: PR #403 extended with costs.read + activity.read SDK capabilities
- Related: PR #396 (plugin SDK), #398 (notifier plugins), scheduled-job example (pattern reference)
- This would be the most complex example plugin yet — showcases the full SDK capability surface
