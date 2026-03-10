import type { AgentAdapterType, CompanyExecutionMode } from "../constants.js";

export interface ExecutionTarget {
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
}

export interface CompanyExecutionPolicy {
  mode: CompanyExecutionMode;
  target: ExecutionTarget | null;
  fallbackChain: ExecutionTarget[];
}

export type HeartbeatResolvedExecutionSource =
  | "company_override"
  | "agent_explicit"
  | "company_default"
  | "agent_implicit_legacy"
  | "company_fallback";

export type HeartbeatFailureCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "config"
  | "provider"
  | "unknown";
