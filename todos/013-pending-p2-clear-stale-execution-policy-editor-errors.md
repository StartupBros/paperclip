---
status: pending
priority: p2
issue_id: 013
tags: [code-review]
---

Problem

Removing an invalid primary target or fallback entry leaves its old validity flag behind, so `hasInvalidEditor` stays `true` and the policy becomes unsaveable even after the invalid editor is gone.

Evidence

- [ui/src/components/CompanyExecutionPolicyCard.tsx](/home/will/SITES/paperclip/ui/src/components/CompanyExecutionPolicyCard.tsx#L76) computes `hasInvalidEditor` from every stored validity entry.
- [ui/src/components/CompanyExecutionPolicyCard.tsx](/home/will/SITES/paperclip/ui/src/components/CompanyExecutionPolicyCard.tsx#L143) removes the primary target without clearing `validity.target`.
- [ui/src/components/CompanyExecutionPolicyCard.tsx](/home/will/SITES/paperclip/ui/src/components/CompanyExecutionPolicyCard.tsx#L214) removes a fallback without deleting its `fallback-{index}` validity entry.

Suggested Fix

Clear the matching validity entry whenever a target/fallback editor is removed, and reindex fallback validity keys after deletions.

Acceptance Criteria

- Removing an invalid primary target re-enables saving if the remaining draft is valid.
- Removing an invalid fallback re-enables saving if the remaining draft is valid.
- A UI test covers both removal flows.
