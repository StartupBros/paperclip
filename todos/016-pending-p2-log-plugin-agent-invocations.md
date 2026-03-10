---
status: pending
priority: p2
issue_id: 016
tags: [code-review]
---

Problem

The new plugin-side `agents.invoke` capability queues heartbeat runs without writing an activity log entry, unlike the existing board/API wakeup path.

Evidence

- [server/src/services/plugin-host-services.ts](/home/will/SITES/paperclip/server/src/services/plugin-host-services.ts#L348) invokes `heartbeats.invoke(...)` and returns the run ID directly.
- [server/src/routes/agents.ts](/home/will/SITES/paperclip/server/src/routes/agents.ts#L1235) logs `heartbeat.invoked` for the normal wakeup route.

Suggested Fix

Emit an activity log entry from the plugin host service after a run is created, including plugin identity and the invoked agent/run IDs.

Acceptance Criteria

- Plugin-triggered agent invocations appear in activity history.
- The actor metadata clearly identifies the plugin/system origin.
- A test covers the logging behavior for `agents.invoke`.
