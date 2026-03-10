/**
 * Tests for the Agent Routines Plugin.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { TestHarness } from "@paperclipai/plugin-sdk";
import manifest from "../../../packages/plugins/examples/plugin-agent-routines/src/manifest.js";
import plugin from "../../../packages/plugins/examples/plugin-agent-routines/src/worker.js";
import {
  nextFireAfter,
  shouldFireAt,
  validateCronExpression,
  validateTimezone,
} from "../../../packages/plugins/examples/plugin-agent-routines/src/cron-match.js";
import {
  getRoutineStateScope,
  normalizeRoutine,
  type RoutineConfig,
} from "../../../packages/plugins/examples/plugin-agent-routines/src/routines.js";

const AGENT_SEED = {
  id: "agent-1",
  companyId: "co-1",
  name: "Health Check Agent",
  title: null,
  role: "engineer" as const,
  reportsTo: null,
  status: "active" as const,
  adapterType: "codex_local" as const,
  adapterConfig: {},
  runtimeConfig: {},
  permissions: { canCreateAgents: false },
  capabilities: null,
  icon: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  lastHeartbeatAt: null,
  metadata: null,
  terminatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  urlKey: "health-check-agent",
};

function createRoutineHarness(config?: Record<string, unknown>): TestHarness {
  return createTestHarness({ manifest, config });
}

function utcDate(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).toISOString();
}

function baseRoutine(overrides: Partial<RoutineConfig> = {}): RoutineConfig {
  return {
    name: "Morning health check",
    cronExpression: "0 9 * * *",
    agentId: "agent-1",
    companyId: "co-1",
    prompt: "Run a production health check",
    enabled: true,
    timezone: "UTC",
    ...overrides,
  };
}

async function setupHarnessWithRoutines(routines: RoutineConfig[]): Promise<TestHarness> {
  const h = createRoutineHarness({ routines });
  h.seed({ agents: [{ ...AGENT_SEED }] });
  await plugin.definition.setup(h.ctx);
  return h;
}

describe("cron-match", () => {
  it("matches simple UTC schedules", () => {
    const date = new Date(Date.UTC(2026, 2, 9, 9, 0));
    expect(shouldFireAt("0 9 * * *", date)).toBe(true);
    expect(shouldFireAt("5 9 * * *", date)).toBe(false);
  });

  it("matches schedules in a non-UTC timezone", () => {
    const date = new Date(Date.UTC(2026, 0, 5, 14, 0)); // 9:00 AM America/New_York
    expect(shouldFireAt("0 9 * * 1", date, "America/New_York")).toBe(true);
    expect(shouldFireAt("0 9 * * 1", date, "UTC")).toBe(false);
  });

  it("computes the next matching fire time", () => {
    const next = nextFireAfter("0 9 * * *", new Date(Date.UTC(2026, 2, 9, 8, 30)), "UTC");
    expect(next?.toISOString()).toBe(utcDate(2026, 3, 9, 9, 0));
  });

  it("validates cron expressions and timezones", () => {
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
    expect(validateCronExpression("invalid cron")).not.toBeNull();
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("Mars/Olympus_Mons")).not.toBeNull();
  });
});

describe("agent-routines plugin dispatcher", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await setupHarnessWithRoutines([baseRoutine()]);
  });

  it("invokes agent when the cron matches and persists routine state", async () => {
    const routine = normalizeRoutine(baseRoutine());

    await h.runJob("routine-dispatcher", {
      scheduledAt: utcDate(2026, 3, 9, 9, 0),
    });

    expect(h.activity).toHaveLength(1);
    expect(h.activity[0].message).toContain("invoked agent agent-1");
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0].tags).toEqual({
      routine: "Morning health check",
      status: "success",
      trigger: "scheduled",
    });

    const state = h.getState(getRoutineStateScope(routine)) as Record<string, unknown>;
    expect(state.lastRunStatus).toBe("success");
    expect(state.lastRunId).toBeTruthy();
    expect(state.lastScheduledAt).toBe(utcDate(2026, 3, 9, 9, 0));
    expect(state.consecutiveErrors).toBe(0);
  });

  it("respects per-routine timezones", async () => {
    h = await setupHarnessWithRoutines([
      baseRoutine({
        name: "NY morning",
        timezone: "America/New_York",
        cronExpression: "0 9 * * 1",
      }),
    ]);

    await h.runJob("routine-dispatcher", {
      scheduledAt: utcDate(2026, 1, 5, 14, 0),
    });

    expect(h.activity).toHaveLength(1);
    expect(h.activity[0].message).toContain("NY morning");
  });

  it("skips disabled routines", async () => {
    h = await setupHarnessWithRoutines([
      baseRoutine({ name: "Disabled routine", enabled: false }),
    ]);

    await h.runJob("routine-dispatcher", {
      scheduledAt: utcDate(2026, 3, 9, 9, 0),
    });

    expect(h.activity).toHaveLength(0);
    expect(h.metrics).toHaveLength(0);
  });

  it("isolates errors so one failing routine does not block another", async () => {
    h = await setupHarnessWithRoutines([
      baseRoutine({ name: "Bad routine", agentId: "missing-agent", cronExpression: "* * * * *" }),
      baseRoutine({ name: "Good routine", cronExpression: "* * * * *" }),
    ]);

    await h.runJob("routine-dispatcher", {
      scheduledAt: utcDate(2026, 3, 9, 9, 0),
    });

    expect(h.activity).toHaveLength(2);
    expect(h.activity[0].message).toContain("failed");
    expect(h.activity[1].message).toContain("invoked");
    expect(h.metrics).toHaveLength(2);
  });

  it("auto-pauses routines after repeated dispatch failures", async () => {
    const routine = baseRoutine({
      name: "Auto pause routine",
      agentId: "missing-agent",
      cronExpression: "* * * * *",
      maxConsecutiveErrorsBeforePause: 2,
    });
    h = await setupHarnessWithRoutines([routine]);

    await h.runJob("routine-dispatcher", { scheduledAt: utcDate(2026, 3, 9, 9, 0) });
    await h.runJob("routine-dispatcher", { scheduledAt: utcDate(2026, 3, 9, 9, 1) });
    await h.runJob("routine-dispatcher", { scheduledAt: utcDate(2026, 3, 9, 9, 2) });

    const state = h.getState(getRoutineStateScope(normalizeRoutine(routine))) as Record<string, unknown>;
    expect(state.lastRunStatus).toBe("error");
    expect(state.consecutiveErrors).toBe(2);
    expect(state.autoPaused).toBe(true);
    expect(state.disabledReason).toContain("Auto-paused");

    // Third tick should be skipped because the routine is auto-paused.
    expect(h.activity).toHaveLength(2);
  });

  it("records deterministic stagger metadata", async () => {
    const routine = baseRoutine({
      name: "Jittered routine",
      cronExpression: "* * * * *",
      staggerMs: 10,
    });
    h = await setupHarnessWithRoutines([routine]);

    await h.runJob("routine-dispatcher", {
      scheduledAt: utcDate(2026, 3, 9, 9, 0),
    });

    const state = h.getState(getRoutineStateScope(normalizeRoutine(routine))) as Record<string, unknown>;
    expect(typeof state.lastStaggerMs).toBe("number");
    expect((state.lastStaggerMs as number)).toBeGreaterThanOrEqual(0);
    expect((state.lastStaggerMs as number)).toBeLessThanOrEqual(10);
  });
});

describe("agent-routines plugin UI handlers", () => {
  it("exposes routine status snapshots with next run preview", async () => {
    const routine = baseRoutine({
      name: "Status routine",
      timezone: "America/New_York",
      cronExpression: "0 9 * * 1",
    });
    const h = await setupHarnessWithRoutines([routine]);

    const data = await h.getData<{
      summary: { total: number; enabled: number; autoPaused: number; failing: number };
      routines: Array<{ key: string; name: string; nextRunAt: string | null; timezone: string }>;
    }>("routines-status", {
      companyId: "co-1",
      now: utcDate(2026, 1, 5, 13, 0),
    });

    expect(data.summary).toEqual({ total: 1, enabled: 1, autoPaused: 0, failing: 0 });
    expect(data.routines).toHaveLength(1);
    expect(data.routines[0].name).toBe("Status routine");
    expect(data.routines[0].timezone).toBe("America/New_York");
    expect(data.routines[0].nextRunAt).toBe(utcDate(2026, 1, 5, 14, 0));
  });

  it("supports manual run and resume actions", async () => {
    const routine = baseRoutine({ name: "Manual routine", cronExpression: "0 9 * * *" });
    const h = await setupHarnessWithRoutines([routine]);
    const normalized = normalizeRoutine(routine);

    const runResult = await h.performAction<{
      ok: boolean;
      routineKey: string;
      runId: string | null;
    }>("run-routine", { routineKey: normalized.key });

    expect(runResult.ok).toBe(true);
    expect(runResult.routineKey).toBe(normalized.key);
    expect(runResult.runId).toBeTruthy();

    await h.ctx.state.set(getRoutineStateScope(normalized), {
      key: normalized.key,
      name: normalized.name,
      companyId: normalized.companyId,
      agentId: normalized.agentId,
      timezone: normalized.timezone,
      lastScheduledAt: null,
      lastRunAt: null,
      lastRunStatus: "error",
      lastRunId: null,
      lastError: "boom",
      lastDispatchDurationMs: null,
      consecutiveErrors: 3,
      autoPaused: true,
      disabledReason: "Auto-paused after repeated failures",
      lastStaggerMs: 0,
    });

    const resumeResult = await h.performAction<{ ok: boolean; routineKey: string }>(
      "resume-routine",
      { routineKey: normalized.key },
    );

    expect(resumeResult).toEqual({ ok: true, routineKey: normalized.key, routineName: normalized.name });

    const resumed = h.getState(getRoutineStateScope(normalized)) as Record<string, unknown>;
    expect(resumed.autoPaused).toBe(false);
    expect(resumed.disabledReason).toBeNull();
    expect(resumed.consecutiveErrors).toBe(0);
  });
});

describe("agent-routines config validation", () => {
  it("accepts valid config", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        baseRoutine({
          timezone: "America/New_York",
          staggerMs: 1500,
          maxConsecutiveErrorsBeforePause: 3,
        }),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid cron expressions, timezones, and duplicate names", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        baseRoutine({ name: "Duplicate", cronExpression: "bad cron" }),
        baseRoutine({ name: "Duplicate", timezone: "Mars/Olympus_Mons" }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some((error: string) => error.includes("invalid cron expression"))).toBe(true);
    expect(result.errors?.some((error: string) => error.includes("invalid timezone"))).toBe(true);
    expect(result.errors?.some((error: string) => error.includes("duplicate name"))).toBe(true);
  });

  it("rejects invalid stagger and auto-pause thresholds", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        baseRoutine({ name: "Bad stagger", staggerMs: -1 }),
        baseRoutine({ name: "Bad threshold", maxConsecutiveErrorsBeforePause: 0 }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.some((error: string) => error.includes("staggerMs"))).toBe(true);
    expect(result.errors?.some((error: string) => error.includes("maxConsecutiveErrorsBeforePause"))).toBe(true);
  });
});

describe("agent-routines manifest", () => {
  it("declares required capabilities", () => {
    expect(manifest.capabilities).toContain("jobs.schedule");
    expect(manifest.capabilities).toContain("agents.invoke");
    expect(manifest.capabilities).toContain("plugin.state.read");
    expect(manifest.capabilities).toContain("plugin.state.write");
  });

  it("declares routine-dispatcher job with 1-minute cron", () => {
    expect(manifest.jobs).toHaveLength(1);
    expect(manifest.jobs![0].jobKey).toBe("routine-dispatcher");
    expect(manifest.jobs![0].schedule).toBe("* * * * *");
  });

  it("includes timezone and stagger support in the config schema", () => {
    const schema = manifest.instanceConfigSchema as any;
    expect(schema.properties.routines.type).toBe("array");
    expect(schema.properties.routines.items.properties.timezone.default).toBe("UTC");
    expect(schema.properties.routines.items.properties.staggerMs.maximum).toBe(300000);
    expect(schema.properties.routines.items.properties.maxConsecutiveErrorsBeforePause.minimum).toBe(1);
  });
});

describe("agent-routines health", () => {
  it("returns ok status", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });
});
