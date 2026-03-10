import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@paperclipai/shared";
import { companyExecutionPolicySchema } from "@paperclipai/shared";
import {
  getFallbackTargetForRetry,
  parseCompanyExecutionPolicy,
  resolveExecutionTarget,
} from "../services/execution-policy.js";

const companyTarget: ExecutionTarget = {
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-4-6" },
};

describe("companyExecutionPolicySchema", () => {
  it("rejects override mode without a target", () => {
    const parsed = companyExecutionPolicySchema.safeParse({
      mode: "override",
      target: null,
      fallbackChain: [],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("execution policy resolution", () => {
  it("uses company override ahead of an explicit agent target", () => {
    const resolved = resolveExecutionTarget({
      agent: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.3-codex" },
      },
      companyExecutionPolicy: {
        mode: "override",
        target: companyTarget,
        fallbackChain: [],
      },
      issueAssigneeOverrides: {
        adapterConfig: { model: "claude-opus-4-1" },
      },
    });

    expect(resolved.source).toBe("company_override");
    expect(resolved.target).toEqual({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-1" },
    });
  });

  it("uses the explicit agent target before company default", () => {
    const resolved = resolveExecutionTarget({
      agent: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.3-codex" },
      },
      companyExecutionPolicy: {
        mode: "default",
        target: companyTarget,
        fallbackChain: [],
      },
    });

    expect(resolved.source).toBe("agent_explicit");
    expect(resolved.target.adapterType).toBe("codex_local");
  });

  it("uses the company default target when the agent has no explicit adapter", () => {
    const resolved = resolveExecutionTarget({
      agent: {
        adapterType: null,
        adapterConfig: null,
      },
      companyExecutionPolicy: {
        mode: "default",
        target: companyTarget,
        fallbackChain: [],
      },
    });

    expect(resolved.source).toBe("company_default");
    expect(resolved.target).toEqual(companyTarget);
  });

  it("prefers the retry target for fallback retries", () => {
    const resolved = resolveExecutionTarget({
      agent: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.3-codex" },
      },
      companyExecutionPolicy: {
        mode: "override",
        target: companyTarget,
        fallbackChain: [],
      },
      retryTarget: {
        adapterType: "cursor",
        adapterConfig: { model: "cursor-max" },
      },
    });

    expect(resolved.source).toBe("company_fallback");
    expect(resolved.target).toEqual({
      adapterType: "cursor",
      adapterConfig: { model: "cursor-max" },
    });
  });

  it("does not merge issue overrides into fallback retry targets", () => {
    const resolved = resolveExecutionTarget({
      agent: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.3-codex" },
      },
      companyExecutionPolicy: {
        mode: "default",
        target: companyTarget,
        fallbackChain: [],
      },
      retryTarget: {
        adapterType: "cursor",
        adapterConfig: { model: "cursor-max", sandbox: "workspace-write" },
      },
      issueAssigneeOverrides: {
        adapterConfig: { model: "claude-opus-4-1", approvalPolicy: "never" },
      },
    });

    expect(resolved.source).toBe("company_fallback");
    expect(resolved.target).toEqual({
      adapterType: "cursor",
      adapterConfig: { model: "cursor-max", sandbox: "workspace-write" },
    });
  });

  it("returns the next fallback by retry ordinal", () => {
    const fallback = getFallbackTargetForRetry(
      {
        mode: "default",
        target: companyTarget,
        fallbackChain: [
          { adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex" } },
          { adapterType: "cursor", adapterConfig: { model: "cursor-max" } },
        ],
      },
      1,
    );

    expect(fallback).toEqual({
      adapterType: "cursor",
      adapterConfig: { model: "cursor-max" },
    });
  });

  it("parses persisted company execution policy objects", () => {
    expect(
      parseCompanyExecutionPolicy({
        mode: "default",
        target: companyTarget,
        fallbackChain: [],
      }),
    ).toEqual({
      mode: "default",
      target: companyTarget,
      fallbackChain: [],
    });
  });
});
