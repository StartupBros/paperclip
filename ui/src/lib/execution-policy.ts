import type {
  Agent,
  CompanyExecutionPolicy,
  HeartbeatFailureCategory,
  HeartbeatResolvedExecutionSource,
} from "@paperclipai/shared";

export const executionSourceLabels: Record<HeartbeatResolvedExecutionSource, string> = {
  company_override: "Company override",
  agent_explicit: "Agent explicit",
  company_default: "Company default",
  agent_implicit_legacy: "Legacy process",
  company_fallback: "Company fallback",
};

export const failureCategoryLabels: Record<HeartbeatFailureCategory, string> = {
  rate_limit: "Rate limit",
  auth: "Auth",
  timeout: "Timeout",
  config: "Config",
  provider: "Provider",
  unknown: "Unknown",
};

export function inferAgentExecutionSource(
  agent: Pick<Agent, "adapterType">,
  companyExecutionPolicy: CompanyExecutionPolicy | null | undefined,
): Exclude<HeartbeatResolvedExecutionSource, "company_fallback"> {
  if (companyExecutionPolicy?.mode === "override" && companyExecutionPolicy.target) {
    return "company_override";
  }
  if (typeof agent.adapterType === "string" && agent.adapterType.trim().length > 0) {
    return "agent_explicit";
  }
  if (companyExecutionPolicy?.target) {
    return "company_default";
  }
  return "agent_implicit_legacy";
}
