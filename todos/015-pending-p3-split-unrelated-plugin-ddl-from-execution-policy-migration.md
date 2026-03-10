---
status: pending
priority: p3
issue_id: 015
tags: [code-review]
---

Problem

Migration `0030_common_magus.sql` mixes the execution-policy columns with first-time creation of the entire plugin schema, which broadens deployment risk and makes the migration hard to validate or roll back.

Evidence

- [packages/db/src/migrations/0030_common_magus.sql](/home/will/SITES/paperclip/packages/db/src/migrations/0030_common_magus.sql#L1) creates the plugin tables.
- [packages/db/src/migrations/0030_common_magus.sql](/home/will/SITES/paperclip/packages/db/src/migrations/0030_common_magus.sql#L88) only later adds the execution-policy and heartbeat columns that match this feature work.

Suggested Fix

Regenerate or split the migration so the execution-policy change ships separately from unrelated plugin DDL, unless the plugin tables are intentionally part of the same release with matching rollout notes.

Acceptance Criteria

- The migration set is scoped to the intended release contents.
- Release notes and deployment order are clear for operators.
