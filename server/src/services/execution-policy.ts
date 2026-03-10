import {
  companyExecutionPolicySchema,
  type CompanyExecutionPolicy,
  type ExecutionTarget,
  type HeartbeatResolvedExecutionSource,
} from "@paperclipai/shared";
import { findServerAdapter } from "../adapters/index.js";
import { unprocessable } from "../errors.js";

interface ResolveExecutionTargetInput {
  agent: {
    adapterType: string | null;
    adapterConfig: unknown;
  };
  companyExecutionPolicy: unknown;
  issueAssigneeOverrides?: {
    adapterConfig: Record<string, unknown> | null;
  } | null;
  retryTarget?: ExecutionTarget | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExecutionTarget(target: ExecutionTarget, fieldLabel: string): ExecutionTarget {
  if (!findServerAdapter(target.adapterType)) {
    throw unprocessable(`Unknown execution policy adapter type: ${target.adapterType}`, {
      field: fieldLabel,
      adapterType: target.adapterType,
    });
  }
  return {
    adapterType: target.adapterType,
    adapterConfig: isPlainObject(target.adapterConfig) ? target.adapterConfig : {},
  };
}

export function parseCompanyExecutionPolicy(input: unknown): CompanyExecutionPolicy | null {
  if (input == null) return null;
  const parsed = companyExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid company execution policy", parsed.error.errors);
  }
  const policy = parsed.data;
  return {
    mode: policy.mode,
    target: policy.target ? normalizeExecutionTarget(policy.target, "target") : null,
    fallbackChain: policy.fallbackChain.map((target, index) =>
      normalizeExecutionTarget(target, `fallbackChain.${index}`)),
  };
}

export function getFallbackTargetForRetry(
  companyExecutionPolicy: unknown,
  retryOrdinal: number,
): ExecutionTarget | null {
  const policy = parseCompanyExecutionPolicy(companyExecutionPolicy);
  if (!policy) return null;
  const nextTarget = policy.fallbackChain[retryOrdinal];
  return nextTarget ? normalizeExecutionTarget(nextTarget, `fallbackChain.${retryOrdinal}`) : null;
}

export function resolveExecutionTarget(
  input: ResolveExecutionTargetInput,
): {
  target: ExecutionTarget;
  source: HeartbeatResolvedExecutionSource;
  companyExecutionPolicy: CompanyExecutionPolicy | null;
} {
  const policy = parseCompanyExecutionPolicy(input.companyExecutionPolicy);
  const retryTarget = input.retryTarget ? normalizeExecutionTarget(input.retryTarget, "retryTarget") : null;

  let baseTarget: ExecutionTarget | null = null;
  let source: HeartbeatResolvedExecutionSource | null = null;

  if (retryTarget) {
    baseTarget = retryTarget;
    source = "company_fallback";
  } else if (policy?.mode === "override") {
    if (!policy.target) {
      throw unprocessable("Company execution override requires a primary target");
    }
    baseTarget = normalizeExecutionTarget(policy.target, "target");
    source = "company_override";
  } else if (typeof input.agent.adapterType === "string" && input.agent.adapterType.length > 0) {
    if (!findServerAdapter(input.agent.adapterType)) {
      throw unprocessable(`Unknown agent adapter type: ${input.agent.adapterType}`, {
        adapterType: input.agent.adapterType,
      });
    }
    const agentAdapterType = input.agent.adapterType as ExecutionTarget["adapterType"];
    baseTarget = {
      adapterType: agentAdapterType,
      adapterConfig: isPlainObject(input.agent.adapterConfig) ? input.agent.adapterConfig : {},
    };
    source = "agent_explicit";
  } else if (policy?.target) {
    baseTarget = normalizeExecutionTarget(policy.target, "target");
    source = "company_default";
  } else {
    baseTarget = {
      adapterType: "process",
      adapterConfig: {},
    };
    source = "agent_implicit_legacy";
  }

  if (!baseTarget || !source) {
    throw unprocessable("Unable to resolve execution target");
  }

  const mergeIssueOverrides = source !== "company_fallback";
  const target: ExecutionTarget = {
    adapterType: baseTarget.adapterType,
    adapterConfig: mergeIssueOverrides && input.issueAssigneeOverrides?.adapterConfig
      ? { ...baseTarget.adapterConfig, ...input.issueAssigneeOverrides.adapterConfig }
      : baseTarget.adapterConfig,
  };

  return {
    target,
    source,
    companyExecutionPolicy: policy,
  };
}
