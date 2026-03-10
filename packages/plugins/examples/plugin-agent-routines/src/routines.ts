export interface RoutineConfig {
  name: string;
  cronExpression: string;
  agentId: string;
  companyId: string;
  prompt: string;
  enabled?: boolean;
  timezone?: string;
  staggerMs?: number;
  maxConsecutiveErrorsBeforePause?: number;
}

export interface NormalizedRoutine extends Omit<RoutineConfig, "enabled" | "timezone" | "staggerMs" | "maxConsecutiveErrorsBeforePause"> {
  key: string;
  enabled: boolean;
  timezone: string;
  staggerMs: number;
  maxConsecutiveErrorsBeforePause: number | null;
}

export interface RoutineDispatchState {
  key: string;
  name: string;
  companyId: string;
  agentId: string;
  timezone: string;
  lastScheduledAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  lastRunId: string | null;
  lastError: string | null;
  lastDispatchDurationMs: number | null;
  consecutiveErrors: number;
  autoPaused: boolean;
  disabledReason: string | null;
  lastStaggerMs: number;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getRoutineKey(routine: Pick<RoutineConfig, "companyId" | "agentId" | "name">): string {
  const slug = routine.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "routine";

  return `${slug}-${hashString(`${routine.companyId}:${routine.agentId}:${routine.name}`)}`;
}

export function normalizeRoutine(routine: RoutineConfig): NormalizedRoutine {
  return {
    ...routine,
    key: getRoutineKey(routine),
    enabled: routine.enabled !== false,
    timezone: routine.timezone?.trim() || "UTC",
    staggerMs: Math.max(0, Math.floor(routine.staggerMs ?? 0)),
    maxConsecutiveErrorsBeforePause:
      routine.maxConsecutiveErrorsBeforePause != null
        ? Math.max(1, Math.floor(routine.maxConsecutiveErrorsBeforePause))
        : null,
  };
}

export function getRoutineStateScope(routine: Pick<NormalizedRoutine, "companyId" | "key">) {
  return {
    scopeKind: "company" as const,
    scopeId: routine.companyId,
    namespace: `routine:${routine.key}`,
    stateKey: "meta",
  };
}

export function defaultRoutineState(routine: Pick<NormalizedRoutine, "key" | "name" | "companyId" | "agentId" | "timezone">): RoutineDispatchState {
  return {
    key: routine.key,
    name: routine.name,
    companyId: routine.companyId,
    agentId: routine.agentId,
    timezone: routine.timezone,
    lastScheduledAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunId: null,
    lastError: null,
    lastDispatchDurationMs: null,
    consecutiveErrors: 0,
    autoPaused: false,
    disabledReason: null,
    lastStaggerMs: 0,
  };
}

export function coerceRoutineState(
  routine: Pick<NormalizedRoutine, "key" | "name" | "companyId" | "agentId" | "timezone">,
  value: unknown,
): RoutineDispatchState {
  const fallback = defaultRoutineState(routine);
  if (!value || typeof value !== "object") return fallback;

  const obj = value as Record<string, unknown>;
  return {
    key: typeof obj.key === "string" ? obj.key : fallback.key,
    name: typeof obj.name === "string" ? obj.name : fallback.name,
    companyId: typeof obj.companyId === "string" ? obj.companyId : fallback.companyId,
    agentId: typeof obj.agentId === "string" ? obj.agentId : fallback.agentId,
    timezone: typeof obj.timezone === "string" ? obj.timezone : fallback.timezone,
    lastScheduledAt: typeof obj.lastScheduledAt === "string" ? obj.lastScheduledAt : null,
    lastRunAt: typeof obj.lastRunAt === "string" ? obj.lastRunAt : null,
    lastRunStatus:
      obj.lastRunStatus === "success" || obj.lastRunStatus === "error"
        ? obj.lastRunStatus
        : null,
    lastRunId: typeof obj.lastRunId === "string" ? obj.lastRunId : null,
    lastError: typeof obj.lastError === "string" ? obj.lastError : null,
    lastDispatchDurationMs:
      typeof obj.lastDispatchDurationMs === "number" ? obj.lastDispatchDurationMs : null,
    consecutiveErrors:
      typeof obj.consecutiveErrors === "number" && Number.isFinite(obj.consecutiveErrors)
        ? obj.consecutiveErrors
        : 0,
    autoPaused: obj.autoPaused === true,
    disabledReason: typeof obj.disabledReason === "string" ? obj.disabledReason : null,
    lastStaggerMs:
      typeof obj.lastStaggerMs === "number" && Number.isFinite(obj.lastStaggerMs)
        ? obj.lastStaggerMs
        : 0,
  };
}
