---
status: pending
priority: p1
issue_id: 017
tags: [code-review]
---

Problem

Automatic fallback retries still merge `issueAssigneeOverrides.adapterConfig` into the company fallback target. If the fallback switches adapters, agent/issue-specific overrides from the original target can overwrite the fallback model or inject incompatible config into the new adapter.

Evidence

- [server/src/services/execution-policy.ts](/home/will/SITES/paperclip/server/src/services/execution-policy.ts#L77) resolves fallback retries from `retryTarget` with source `company_fallback`.
- [server/src/services/execution-policy.ts](/home/will/SITES/paperclip/server/src/services/execution-policy.ts#L113) always merges `issueAssigneeOverrides.adapterConfig` into the resolved target, regardless of source or adapter type.
- [server/src/services/heartbeat.ts](/home/will/SITES/paperclip/server/src/services/heartbeat.ts#L1324) passes both `retryTarget` and `issueAssigneeOverrides` during retry execution, so fallback retries inherit the original issue-level overrides.

Suggested Fix

Do not blindly merge issue-assignee overrides when `source === "company_fallback"`, or only merge keys that are proven safe across adapters. At minimum, keep the fallback target's own adapter/model intact when the retry switches adapter type.

Acceptance Criteria

- A fallback retry uses the adapter and model configured in the company fallback chain.
- Issue-level overrides do not corrupt fallback targets when the retry adapter differs from the original adapter.
- A server test covers a retry from one adapter to a different fallback adapter with issue-assignee overrides present.
