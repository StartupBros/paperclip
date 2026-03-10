import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";

const companyServiceMock = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const portabilityServiceMock = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const accessServiceMock = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const secretServiceMock = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
}));

const logActivityMock = vi.hoisted(() => vi.fn());
const parseCompanyExecutionPolicyMock = vi.hoisted(() => vi.fn((value: unknown) => value));

vi.mock("../services/index.js", () => ({
  companyService: () => companyServiceMock,
  companyPortabilityService: () => portabilityServiceMock,
  accessService: () => accessServiceMock,
  secretService: () => secretServiceMock,
  logActivity: logActivityMock,
  parseCompanyExecutionPolicy: parseCompanyExecutionPolicyMock,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/companies/:companyId execution policy", () => {
  beforeEach(() => {
    companyServiceMock.getById.mockReset();
    companyServiceMock.update.mockReset();
    secretServiceMock.normalizeAdapterConfigForPersistence.mockReset();
    logActivityMock.mockReset();
    parseCompanyExecutionPolicyMock.mockReset();
    parseCompanyExecutionPolicyMock.mockImplementation((value: unknown) => value);
  });

  it("returns 422 for an invalid execution policy payload", async () => {
    const app = createApp();

    const response = await request(app)
      .patch("/api/companies/company-1")
      .send({
        executionPolicy: {
          mode: "default",
          target: {
            adapterType: "not_real",
            adapterConfig: {},
          },
        },
      });

    expect(response.status).toBe(422);
    expect(companyServiceMock.getById).not.toHaveBeenCalled();
    expect(companyServiceMock.update).not.toHaveBeenCalled();
  });

  it("normalizes and persists execution policy targets", async () => {
    companyServiceMock.getById.mockResolvedValue({
      id: "company-1",
      name: "Test Co",
      executionPolicy: null,
    });
    secretServiceMock.normalizeAdapterConfigForPersistence.mockResolvedValue({
      model: "claude-sonnet-4-6",
    });
    companyServiceMock.update.mockResolvedValue({
      id: "company-1",
      name: "Test Co",
      executionPolicy: {
        mode: "default",
        target: {
          adapterType: "claude_local",
          adapterConfig: { model: "claude-sonnet-4-6" },
        },
        fallbackChain: [],
      },
    });

    const app = createApp();

    const response = await request(app)
      .patch("/api/companies/company-1")
      .send({
        executionPolicy: {
          mode: "default",
          target: {
            adapterType: "claude_local",
            adapterConfig: { model: "claude-sonnet-4-6" },
          },
          fallbackChain: [],
        },
      });

    expect(response.status).toBe(200);
    expect(secretServiceMock.normalizeAdapterConfigForPersistence).toHaveBeenCalledWith(
      "company-1",
      { model: "claude-sonnet-4-6" },
    );
    expect(companyServiceMock.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        executionPolicy: {
          mode: "default",
          target: {
            adapterType: "claude_local",
            adapterConfig: { model: "claude-sonnet-4-6" },
          },
          fallbackChain: [],
        },
      }),
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company.execution_policy_updated",
        companyId: "company-1",
      }),
    );
  });
});
