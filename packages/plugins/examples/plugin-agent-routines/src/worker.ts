import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { nextFireAfter, shouldFireAt, validateCronExpression, validateTimezone } from "./cron-match.js";
import {
  coerceRoutineState,
  getRoutineStateScope,
  normalizeRoutine,
  type NormalizedRoutine,
  type RoutineConfig,
  type RoutineDispatchState,
} from "./routines.js";

interface RoutinesConfig {
  routines?: RoutineConfig[];
}

type DispatchOutcomeKind =
  | "success"
  | "error"
  | "skipped_disabled"
  | "skipped_not_due"
  | "skipped_auto_paused";

interface DispatchOutcome {
  kind: DispatchOutcomeKind;
  routine: NormalizedRoutine;
  runId?: string;
  error?: string;
  staggerMs?: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function computeStaggerDelayMs(routine: NormalizedRoutine, scheduledAt: string): number {
  if (routine.staggerMs <= 0) return 0;
  const bucket = `${routine.key}:${scheduledAt.slice(0, 16)}`;
  return hashString(bucket) % (routine.staggerMs + 1);
}

function renderPromptTemplate(prompt: string, routine: NormalizedRoutine, scheduledAt: Date): string {
  const iso = scheduledAt.toISOString();
  const replacements: Record<string, string> = {
    now: iso,
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    companyId: routine.companyId,
    agentId: routine.agentId,
    routineName: routine.name,
  };

  return prompt.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey === "routine.name" ? "routineName" : rawKey;
    return replacements[key] ?? "";
  });
}

async function loadConfig(ctx: PluginContext): Promise<NormalizedRoutine[]> {
  const config = await ctx.config.get() as RoutinesConfig;
  return (config?.routines ?? []).map(normalizeRoutine);
}

async function loadRoutineState(ctx: PluginContext, routine: NormalizedRoutine): Promise<RoutineDispatchState> {
  const raw = await ctx.state.get(getRoutineStateScope(routine));
  return coerceRoutineState(routine, raw);
}

async function saveRoutineState(
  ctx: PluginContext,
  routine: NormalizedRoutine,
  state: RoutineDispatchState,
): Promise<void> {
  await ctx.state.set(getRoutineStateScope(routine), state);
}

async function buildRoutineSnapshot(ctx: PluginContext, routine: NormalizedRoutine, now: Date) {
  const state = await loadRoutineState(ctx, routine);
  const nextRunAt = routine.enabled ? nextFireAfter(routine.cronExpression, now, routine.timezone) : null;

  return {
    key: routine.key,
    name: routine.name,
    agentId: routine.agentId,
    companyId: routine.companyId,
    prompt: routine.prompt,
    enabled: routine.enabled,
    timezone: routine.timezone,
    staggerMs: routine.staggerMs,
    maxConsecutiveErrorsBeforePause: routine.maxConsecutiveErrorsBeforePause,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    autoPaused: state.autoPaused,
    disabledReason: state.disabledReason,
    lastRunAt: state.lastRunAt,
    lastRunStatus: state.lastRunStatus,
    lastRunId: state.lastRunId,
    lastError: state.lastError,
    lastDispatchDurationMs: state.lastDispatchDurationMs,
    consecutiveErrors: state.consecutiveErrors,
    lastStaggerMs: state.lastStaggerMs,
    lastScheduledAt: state.lastScheduledAt,
  };
}

function summarizeSnapshots(
  snapshots: Array<{ enabled: boolean; autoPaused: boolean; lastRunStatus: string | null }>,
) {
  return {
    total: snapshots.length,
    enabled: snapshots.filter((snapshot) => snapshot.enabled).length,
    autoPaused: snapshots.filter((snapshot) => snapshot.autoPaused).length,
    failing: snapshots.filter((snapshot) => snapshot.lastRunStatus === "error").length,
  };
}

function findRoutine(
  routines: NormalizedRoutine[],
  params: Record<string, unknown>,
): NormalizedRoutine | undefined {
  const routineKey = typeof params.routineKey === "string" ? params.routineKey : null;
  const routineName = typeof params.routineName === "string" ? params.routineName : null;

  return routines.find((routine) => {
    if (routineKey) return routine.key === routineKey;
    if (routineName) return routine.name === routineName;
    return false;
  });
}

async function dispatchRoutine(
  ctx: PluginContext,
  routine: NormalizedRoutine,
  scheduledAt: Date,
  opts: { manual?: boolean } = {},
): Promise<DispatchOutcome> {
  if (!routine.enabled) {
    return { kind: "skipped_disabled", routine };
  }

  const state = await loadRoutineState(ctx, routine);
  if (state.autoPaused) {
    return {
      kind: "skipped_auto_paused",
      routine,
      error: state.disabledReason ?? "Routine is auto-paused",
    };
  }

  if (!opts.manual && !shouldFireAt(routine.cronExpression, scheduledAt, routine.timezone)) {
    return { kind: "skipped_not_due", routine };
  }

  const scheduledAtIso = scheduledAt.toISOString();
  const staggerMs = opts.manual ? 0 : computeStaggerDelayMs(routine, scheduledAtIso);
  if (staggerMs > 0) {
    await sleep(staggerMs);
  }

  const startedAt = Date.now();
  const renderedPrompt = renderPromptTemplate(routine.prompt, routine, scheduledAt);

  try {
    const result = await ctx.agents.invoke(routine.agentId, routine.companyId, {
      prompt: renderedPrompt,
      reason: opts.manual
        ? `Manual routine run: ${routine.name}`
        : `Scheduled routine: ${routine.name}`,
    });

    const finishedAt = new Date().toISOString();
    const nextState: RoutineDispatchState = {
      ...state,
      key: routine.key,
      name: routine.name,
      companyId: routine.companyId,
      agentId: routine.agentId,
      timezone: routine.timezone,
      lastScheduledAt: scheduledAtIso,
      lastRunAt: finishedAt,
      lastRunStatus: "success",
      lastRunId: result.runId,
      lastError: null,
      lastDispatchDurationMs: Date.now() - startedAt,
      consecutiveErrors: 0,
      autoPaused: false,
      disabledReason: null,
      lastStaggerMs: staggerMs,
    };

    await saveRoutineState(ctx, routine, nextState);

    await ctx.activity.log({
      companyId: routine.companyId,
      message: `Routine "${routine.name}" invoked agent ${routine.agentId} (run: ${result.runId})`,
      entityType: "agent",
      entityId: routine.agentId,
    });

    await ctx.metrics.write("routine_invocation_total", 1, {
      routine: routine.name,
      status: "success",
      trigger: opts.manual ? "manual" : "scheduled",
    });

    return { kind: "success", routine, runId: result.runId, staggerMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveErrors = state.consecutiveErrors + 1;
    const shouldAutoPause =
      routine.maxConsecutiveErrorsBeforePause != null
      && consecutiveErrors >= routine.maxConsecutiveErrorsBeforePause;

    const nextState: RoutineDispatchState = {
      ...state,
      key: routine.key,
      name: routine.name,
      companyId: routine.companyId,
      agentId: routine.agentId,
      timezone: routine.timezone,
      lastScheduledAt: scheduledAtIso,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "error",
      lastRunId: null,
      lastError: message,
      lastDispatchDurationMs: Date.now() - startedAt,
      consecutiveErrors,
      autoPaused: shouldAutoPause,
      disabledReason: shouldAutoPause
        ? `Auto-paused after ${consecutiveErrors} consecutive dispatch failures`
        : null,
      lastStaggerMs: staggerMs,
    };

    await saveRoutineState(ctx, routine, nextState);

    ctx.logger.error(`Routine "${routine.name}" failed: ${message}`, {
      routine: routine.name,
      agentId: routine.agentId,
      companyId: routine.companyId,
      error: message,
      autoPaused: shouldAutoPause,
    });

    await ctx.activity.log({
      companyId: routine.companyId,
      message: shouldAutoPause
        ? `Routine "${routine.name}" auto-paused after failing to invoke agent ${routine.agentId}: ${message}`
        : `Routine "${routine.name}" failed to invoke agent ${routine.agentId}: ${message}`,
      entityType: "agent",
      entityId: routine.agentId,
    });

    await ctx.metrics.write("routine_invocation_total", 1, {
      routine: routine.name,
      status: "error",
      trigger: opts.manual ? "manual" : "scheduled",
    });

    return { kind: "error", routine, error: message, staggerMs };
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("routine-dispatcher", async (job) => {
      const routines = await loadConfig(ctx);
      const scheduledAt = new Date(job.scheduledAt);

      const outcomes = await Promise.all(
        routines.map((routine) => dispatchRoutine(ctx, routine, scheduledAt)),
      );

      const fired = outcomes.filter((outcome) => outcome.kind === "success").length;
      const errors = outcomes.filter((outcome) => outcome.kind === "error").length;
      const paused = outcomes.filter((outcome) => outcome.kind === "skipped_auto_paused").length;
      const skipped = outcomes.filter((outcome) => outcome.kind === "skipped_not_due").length;
      const disabled = outcomes.filter((outcome) => outcome.kind === "skipped_disabled").length;

      if (fired > 0 || errors > 0 || paused > 0) {
        ctx.logger.info("Dispatcher tick complete", {
          fired,
          errors,
          paused,
          skipped,
          disabled,
          scheduledAt: job.scheduledAt,
        });
      }
    });

    ctx.data.register("routines-status", async (params) => {
      const nowParam = typeof params.now === "string" ? params.now : null;
      const companyIdFilter = typeof params.companyId === "string" ? params.companyId : null;
      const now = nowParam ? new Date(nowParam) : new Date();
      const routines = await loadConfig(ctx);
      const filtered = companyIdFilter
        ? routines.filter((routine) => routine.companyId === companyIdFilter)
        : routines;

      const snapshots = await Promise.all(
        filtered.map((routine) => buildRoutineSnapshot(ctx, routine, now)),
      );

      return {
        generatedAt: now.toISOString(),
        summary: summarizeSnapshots(snapshots),
        routines: snapshots,
      };
    });

    ctx.actions.register("run-routine", async (params) => {
      const routines = await loadConfig(ctx);
      const routine = findRoutine(routines, params);
      if (!routine) {
        throw new Error("Routine not found");
      }

      const outcome = await dispatchRoutine(ctx, routine, new Date(), { manual: true });
      if (outcome.kind === "error") {
        throw new Error(outcome.error ?? `Routine "${routine.name}" failed`);
      }
      if (outcome.kind === "skipped_auto_paused") {
        throw new Error(outcome.error ?? `Routine "${routine.name}" is auto-paused`);
      }
      if (outcome.kind === "skipped_disabled") {
        throw new Error(`Routine "${routine.name}" is disabled`);
      }

      return {
        ok: true,
        routineKey: routine.key,
        routineName: routine.name,
        runId: outcome.runId ?? null,
        staggerMs: outcome.staggerMs ?? 0,
      };
    });

    ctx.actions.register("resume-routine", async (params) => {
      const routines = await loadConfig(ctx);
      const routine = findRoutine(routines, params);
      if (!routine) {
        throw new Error("Routine not found");
      }

      const state = await loadRoutineState(ctx, routine);
      const nextState: RoutineDispatchState = {
        ...state,
        autoPaused: false,
        disabledReason: null,
        consecutiveErrors: 0,
      };
      await saveRoutineState(ctx, routine, nextState);

      await ctx.activity.log({
        companyId: routine.companyId,
        message: `Routine "${routine.name}" was resumed`,
        entityType: "agent",
        entityId: routine.agentId,
      });

      return {
        ok: true,
        routineKey: routine.key,
        routineName: routine.name,
      };
    });
  },

  async onValidateConfig(config) {
    const routines = (config as RoutinesConfig)?.routines;
    if (!routines || !Array.isArray(routines)) return { ok: true };

    const errors: string[] = [];
    const seenNames = new Set<string>();

    for (let i = 0; i < routines.length; i++) {
      const routine = routines[i]!;
      const label = routine.name?.trim() || `Routine ${i + 1}`;

      const duplicateKey = `${routine.companyId}:${label.toLowerCase()}`;
      if (seenNames.has(duplicateKey)) {
        errors.push(`Routine "${label}": duplicate name within the same company`);
      } else {
        seenNames.add(duplicateKey);
      }

      const cronError = validateCronExpression(routine.cronExpression);
      if (cronError) {
        errors.push(`Routine "${label}": invalid cron expression — ${cronError}`);
      }

      const timezoneError = validateTimezone(routine.timezone?.trim() || "UTC");
      if (timezoneError) {
        errors.push(`Routine "${label}": invalid timezone — ${timezoneError}`);
      }

      if (routine.staggerMs != null && (!Number.isInteger(routine.staggerMs) || routine.staggerMs < 0 || routine.staggerMs > 300_000)) {
        errors.push(`Routine "${label}": staggerMs must be an integer between 0 and 300000`);
      }

      if (
        routine.maxConsecutiveErrorsBeforePause != null
        && (!Number.isInteger(routine.maxConsecutiveErrorsBeforePause)
          || routine.maxConsecutiveErrorsBeforePause < 1
          || routine.maxConsecutiveErrorsBeforePause > 100)
      ) {
        errors.push(`Routine "${label}": maxConsecutiveErrorsBeforePause must be an integer between 1 and 100`);
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Agent routines plugin ready" };
  },
});

export default plugin;
export { getRoutineKey, getRoutineStateScope } from "./routines.js";
runWorker(plugin, import.meta.url);
