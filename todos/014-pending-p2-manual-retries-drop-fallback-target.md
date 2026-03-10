---
status: pending
priority: p2
issue_id: 014
tags: [code-review]
---

Problem

Manual retries only preserve `retryOfRunId`, not the previously resolved fallback target. Retrying a failed fallback run can therefore jump back to the company or agent primary target instead of rerunning the same fallback target.

Evidence

- [ui/src/pages/AgentDetail.tsx](/home/will/SITES/paperclip/ui/src/pages/AgentDetail.tsx#L1567) builds the retry payload with lineage fields only.
- [server/src/services/heartbeat.ts](/home/will/SITES/paperclip/server/src/services/heartbeat.ts#L471) only reuses a retry target when `_paperclipRetryTarget` is present in the run context.
- [server/src/services/heartbeat.ts](/home/will/SITES/paperclip/server/src/services/heartbeat.ts#L2074) manual retry lineage increments `retryOrdinal`, but does not restore the failed run's `resolvedExecutionTarget`.

Suggested Fix

When the source run already resolved to `company_fallback`, include that target in the retry wakeup context or teach `enqueueWakeup` to copy `resolvedExecutionTarget` from the parent run for manual retries.

Acceptance Criteria

- Retrying a failed fallback run uses the same fallback adapter/config unless the user explicitly chooses a different target.
- The retry lineage remains intact.
- A server or UI test covers manual retry of a fallback run.
