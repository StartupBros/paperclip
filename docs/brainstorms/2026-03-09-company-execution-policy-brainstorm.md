---
title: Company Execution Policy
type: feat
date: 2026-03-09
---

# Company Execution Policy

## What We're Building

A core platform feature that lets each company define its default execution policy for agents:

- default adapter target
- optional rate-limit-only fallback chain

This policy is used when an agent does not have an explicit model selection of its own. Existing override layers remain intact:

1. issue-level assignee adapter overrides
2. agent-level explicit adapter config
3. company-level execution policy

The first user-visible outcome is operational control: when one provider quota is exhausted, the board can switch the company execution target once instead of editing every agent. The second outcome is limited resilience: if a run fails specifically because of a rate limit or quota condition, Paperclip can retry with the next configured fallback.

## Why This Approach

### Platform, not plugin

This belongs in core platform code, not the plugin system.

The current model-resolution path happens inside heartbeat execution before plugin hooks are relevant. Plugins can extend tools, jobs, webhooks, and UI surfaces, but they are not the right layer for:

- new columns or first-class fields on `companies`
- runtime model resolution during heartbeat execution
- classifying adapter failures into retryable vs non-retryable categories
- re-queueing failed runs as a host-owned orchestration behavior

Paperclip also already treats `company` as the main tenancy and control-plane boundary. A company-owned execution policy fits that shape directly.

### Company-scoped, not instance-scoped

Paperclip is a single deployment that can host multiple companies. Execution policy should follow that tenancy boundary. Different companies may have different budgets, providers, risk tolerance, and preferred models.

Adding instance-wide policy now would create a second policy axis before the first one proves useful. That is avoidable complexity.

### Rate-limit failover only

Automatic fallback should be narrow in the first version. Retrying on any failure would mask real problems like bad auth, broken prompts, invalid config, or adapter bugs. Restricting failover to quota and rate-limit conditions keeps the feature legible and safer to trust.

## Recommended Approach

Build a company-owned execution policy in core:

- `companies.executionPolicy` as a structured JSON object that mirrors the existing agent shape

Proposed shape:

```json
{
  "mode": "default",
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-sonnet-4-6"
  },
  "fallbackChain": [
    {
      "adapterType": "codex_local",
      "adapterConfig": {
        "model": "gpt-5.3-codex"
      }
    }
  ]
}
```

Recommended modes:

- `default`: applies only when a lower layer does not specify an execution target
- `override`: company policy temporarily wins over agent execution target for manual fleet-wide switching

When `override` is active, it should apply to new runs only. In-flight runs should continue on the execution target they started with.

Resolution order:

1. issue override
2. company policy when `mode = override`
3. agent explicit config
4. company policy when `mode = default`

Fallback behavior:

1. run starts with resolved adapter/model
2. adapter returns a classified failure
3. if failure category is `rate_limit` and a fallback remains, Paperclip re-queues a retry with the next fallback target
4. otherwise the run fails normally

This gives immediate operational value without introducing a generic policy engine or named profile system. It also acknowledges a critical product fact: agents are currently created with explicit `adapterType` and `adapterConfig.model`, so a company-level default alone would not solve the manual "switch everyone off Claude right now" use case.

## Alternatives Considered

### 1. Full policy stack

Add instance defaults above company settings and support richer multi-layer precedence immediately.

Pros:

- maximum flexibility
- future-friendly if Paperclip becomes heavily multi-tenant

Cons:

- more precedence rules
- harder UI and mental model
- not necessary for the current self-hosted pain point

### 2. Reusable execution profiles

Create named profiles such as "Claude Sonnet", "Codex backup", or "Cursor fast" and assign those profiles to companies, agents, or issues.

Pros:

- elegant abstraction
- more reusable long-term

Cons:

- larger product concept
- slower to ship
- premature relative to the current need

## Key Decisions

1. **Core feature:** This is part of the platform, not a plugin.

2. **Primary scope:** Policy lives on each company, not at the instance layer.

3. **Policy modes:** Company policy needs `default` and `override` modes because agents currently persist explicit execution targets.

4. **Fallback scope:** Retry only for classified rate-limit or quota failures.

5. **Switch semantics:** `default` mode affects inheriting agents only. `override` mode can supersede agent execution targets at runtime, but should not silently rewrite agent records.

6. **Data model shape:** Company policy should mirror the existing execution tuple of `adapterType` plus `adapterConfig`, stored as a single structured `executionPolicy` object rather than split scalar fields.

7. **Override safety:** When override mode is active, the UI should make that state impossible to miss and provide a one-click path back to default mode.

8. **Retry record model:** Fallback should create a new run record linked to the original attempt rather than hiding retries inside one run.

9. **Shipping strategy:** Build the full useful version locally first, then upstream in small slices.

## What This Likely Touches

- `packages/db`
  - new company execution policy field and validation
- `packages/shared`
  - company types and validators
- `server`
  - company service and routes
  - heartbeat resolution path
  - adapter failure classification contract
  - retry run linkage model
- `ui`
  - company settings for execution policy
  - likely a bulk-apply affordance for agents that rely on inherited defaults
  - clear inherited-vs-explicit indicators on agent views
  - persistent override-mode banner with revert action

## Main Risk

The riskiest implementation piece is adapter failure classification.

Today adapters mostly surface exit code, timeout, and error text. Automatic fallback needs a structured taxonomy such as:

- `rate_limit`
- `auth_failure`
- `timeout`
- `unknown`

Each adapter would need to map provider-specific failures into that taxonomy reliably enough that Paperclip retries only when it should.

## Upstream Strategy

The full local feature is worth building now because it solves an immediate operator pain point. Upstream should be proposed in mergeable slices rather than one large PR.

Suggested slices:

1. company execution policy field
2. heartbeat resolution that inherits company defaults when agent config is unset
3. company settings UI for execution policy and mode switching
4. rate-limit fallback classification and retry behavior

This keeps the early slices valuable even if maintainers are not yet ready for automatic fallback.

## Open Questions

1. `executionPolicy` should remain a JSON column unless a future use case proves normalization is needed.

2. Should Paperclip later offer a separate bulk action to clear agent-level explicit model settings so selected agents begin inheriting again?

3. Should the issue override layer also gain `adapterType` override support, or should cross-adapter changes remain limited to agent and company policy for now?

4. The UI should present inherited values directly on each agent so operators can tell whether a model is explicit or inherited.

5. Rate-limit fallback should create a new heartbeat run record linked to the original run, rather than retrying invisibly within one logical run.
