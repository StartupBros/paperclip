import { z } from "zod";
import { AGENT_ADAPTER_TYPES, COMPANY_EXECUTION_MODES, COMPANY_STATUSES } from "../constants.js";
import { envConfigSchema } from "./secret.js";

const executionTargetAdapterConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "executionPolicy adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const executionTargetSchema = z.object({
  adapterType: z.enum(AGENT_ADAPTER_TYPES),
  adapterConfig: executionTargetAdapterConfigSchema.optional().default({}),
});

export const companyExecutionPolicySchema = z.object({
  mode: z.enum(COMPANY_EXECUTION_MODES).default("default"),
  target: executionTargetSchema.nullable().default(null),
  fallbackChain: z.array(executionTargetSchema).default([]),
}).superRefine((value, ctx) => {
  if (value.mode === "override" && !value.target) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "executionPolicy.target is required when mode is override",
      path: ["target"],
    });
  }
});

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    requireHumanApprovalForAllActions: z.boolean().optional(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    executionPolicy: companyExecutionPolicySchema.nullable().optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;
