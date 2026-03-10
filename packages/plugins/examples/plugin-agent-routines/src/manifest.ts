import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.agent-routines",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Agent Routines",
  description:
    "Run agents on cron schedules with prompts, timezones, jitter, persistent routine state, and failure guardrails.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "agents.invoke",
    "agents.read",
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      routines: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Human-readable label for the routine" },
            cronExpression: { type: "string", description: "5-field cron (e.g. '0 9 * * 1-5')" },
            timezone: {
              type: "string",
              description: "IANA timezone (e.g. 'UTC' or 'America/New_York')",
              default: "UTC",
            },
            staggerMs: {
              type: "integer",
              description: "Deterministic jitter window in milliseconds",
              minimum: 0,
              maximum: 300000,
              default: 0,
            },
            agentId: { type: "string", description: "Target agent UUID" },
            companyId: { type: "string", description: "Company the agent belongs to" },
            prompt: { type: "string", description: "What the agent should do on each run" },
            enabled: { type: "boolean", default: true },
            maxConsecutiveErrorsBeforePause: {
              type: "integer",
              description: "Auto-pause the routine after this many consecutive dispatch failures",
              minimum: 1,
              maximum: 100,
            },
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
