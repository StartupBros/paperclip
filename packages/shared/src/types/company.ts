import type { CompanyStatus } from "../constants.js";
import type { CompanyExecutionPolicy } from "./execution-policy.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  requireHumanApprovalForAllActions: boolean;
  brandColor: string | null;
  executionPolicy: CompanyExecutionPolicy | null;
  createdAt: Date;
  updatedAt: Date;
}
