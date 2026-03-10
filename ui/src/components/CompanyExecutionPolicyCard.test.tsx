import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { CompanyExecutionPolicyCard } from "./CompanyExecutionPolicyCard";

vi.mock("@/api/companies", () => ({
  companiesApi: {
    update: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn(),
  },
}));

vi.mock("./agent-config-primitives", () => ({
  adapterLabels: {
    claude_local: "Claude (local)",
    codex_local: "Codex (local)",
    opencode_local: "OpenCode (local)",
    openclaw_gateway: "OpenClaw Gateway",
    cursor: "Cursor (local)",
    process: "Process",
    http: "HTTP",
  },
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      <span>{label}</span>
      {children}
    </label>
  ),
  HintIcon: () => <span data-testid="hint-icon" />,
}));

vi.mock("./ExecutionTargetEditor", () => ({
  ExecutionTargetEditor: ({
    label,
    value,
    onChange,
    onValidityChange,
  }: {
    label: string;
    value: { adapterType: string; adapterConfig: Record<string, unknown> };
    onChange: (value: { adapterType: string; adapterConfig: Record<string, unknown> }) => void;
    onValidityChange?: (valid: boolean) => void;
  }) => {
    const [text, setText] = React.useState(JSON.stringify(value.adapterConfig, null, 2));

    React.useEffect(() => {
      setText(JSON.stringify(value.adapterConfig, null, 2));
    }, [value]);

    return (
      <label>
        <span>{label}</span>
        <textarea
          aria-label={`${label} adapter config`}
          value={text}
          onChange={(event) => {
            const nextText = event.target.value;
            setText(nextText);
            try {
              const parsed = JSON.parse(nextText) as Record<string, unknown>;
              onValidityChange?.(true);
              onChange({
                adapterType: value.adapterType,
                adapterConfig: parsed,
              });
            } catch {
              onValidityChange?.(false);
            }
          }}
        />
      </label>
    );
  },
}));

function renderComponent(company: Company) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CompanyExecutionPolicyCard company={company} />
    </QueryClientProvider>,
  );

  return {
    ...rendered,
    queryClient,
  };
}

const baseCompany: Company = {
  id: "company-1",
  name: "Test Co",
  description: null,
  status: "active",
  issuePrefix: "PC",
  issueCounter: 1,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  requireBoardApprovalForNewAgents: false,
  requireHumanApprovalForAllActions: false,
  brandColor: null,
  executionPolicy: null,
  createdAt: new Date("2026-03-10T00:00:00Z"),
  updatedAt: new Date("2026-03-10T00:00:00Z"),
};

describe("CompanyExecutionPolicyCard", () => {
  let queryClient: QueryClient | null = null;

  beforeEach(async () => {
    const { companiesApi } = await import("@/api/companies");
    const { agentsApi } = await import("@/api/agents");
    vi.mocked(companiesApi.update).mockReset();
    vi.mocked(agentsApi.adapterModels).mockReset();
    vi.mocked(agentsApi.adapterModels).mockResolvedValue([]);
  });

  afterEach(() => {
    queryClient?.clear();
    queryClient = null;
    cleanup();
  });

  it("saves a newly configured primary target", async () => {
    const { companiesApi } = await import("@/api/companies");
    vi.mocked(companiesApi.update).mockResolvedValue({
      ...baseCompany,
      executionPolicy: {
        mode: "default",
        target: { adapterType: "claude_local", adapterConfig: {} },
        fallbackChain: [],
      },
    });

    ({ queryClient } = renderComponent(baseCompany));

    fireEvent.click(screen.getByText("Set primary target"));

    const saveButton = await screen.findByText("Save execution policy");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(companiesApi.update).toHaveBeenCalledWith("company-1", {
        executionPolicy: {
          mode: "default",
          target: {
            adapterType: "claude_local",
            adapterConfig: {},
          },
          fallbackChain: [],
        },
      });
    });
  });

  it("disables save when adapter config JSON is invalid", async () => {
    ({ queryClient } = renderComponent({
      ...baseCompany,
      executionPolicy: {
        mode: "default",
        target: {
          adapterType: "claude_local",
          adapterConfig: {},
        },
        fallbackChain: [],
      },
    }));

    const textareas = screen.getAllByRole("textbox");
    fireEvent.change(textareas[textareas.length - 1]!, {
      target: { value: "{" },
    });

    expect(
      await screen.findByText("Adapter config JSON must be valid before saving."),
    ).toBeTruthy();
    expect(screen.getByText("Save execution policy")).toHaveProperty("disabled", true);
  });

  it("clears stale primary-target validity when the invalid editor is removed", async () => {
    ({ queryClient } = renderComponent({
      ...baseCompany,
      executionPolicy: {
        mode: "default",
        target: {
          adapterType: "claude_local",
          adapterConfig: {},
        },
        fallbackChain: [],
      },
    }));

    fireEvent.change(screen.getByLabelText("Primary target adapter config"), {
      target: { value: "{" },
    });

    expect(
      await screen.findByText("Adapter config JSON must be valid before saving."),
    ).toBeTruthy();
    expect(screen.getByText("Save execution policy")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByText("Remove primary target"));

    await waitFor(() => {
      expect(screen.queryByText("Adapter config JSON must be valid before saving.")).toBeNull();
      expect(screen.getByText("Save execution policy")).toHaveProperty("disabled", false);
    });
  });

  it("reindexes fallback validity when removing an invalid fallback editor", async () => {
    ({ queryClient } = renderComponent({
      ...baseCompany,
      executionPolicy: {
        mode: "default",
        target: {
          adapterType: "claude_local",
          adapterConfig: {},
        },
        fallbackChain: [
          { adapterType: "claude_local", adapterConfig: {} },
          { adapterType: "claude_local", adapterConfig: {} },
        ],
      },
    }));

    fireEvent.change(screen.getByLabelText("Fallback 2 adapter config"), {
      target: { value: "{" },
    });

    expect(
      await screen.findByText("Adapter config JSON must be valid before saving."),
    ).toBeTruthy();
    expect(screen.getByText("Save execution policy")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getAllByText("Remove fallback")[1]!);

    await waitFor(() => {
      expect(screen.queryByText("Adapter config JSON must be valid before saving.")).toBeNull();
      expect(screen.getByText("Save execution policy")).toHaveProperty("disabled", false);
    });
  });

  it("clears stale editor validity when resetting the draft", async () => {
    ({ queryClient } = renderComponent({
      ...baseCompany,
      executionPolicy: {
        mode: "default",
        target: {
          adapterType: "claude_local",
          adapterConfig: {},
        },
        fallbackChain: [],
      },
    }));

    fireEvent.change(screen.getByLabelText("Primary target adapter config"), {
      target: { value: "{" },
    });

    expect(
      await screen.findByText("Adapter config JSON must be valid before saving."),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Reset"));

    await waitFor(() => {
      expect(screen.queryByText("Adapter config JSON must be valid before saving.")).toBeNull();
      expect(screen.queryByText("Save execution policy")).toBeNull();
    });
  });

  it("shows a persistent warning when override mode is active", async () => {
    ({ queryClient } = renderComponent({
      ...baseCompany,
      executionPolicy: {
        mode: "override",
        target: {
          adapterType: "claude_local",
          adapterConfig: {},
        },
        fallbackChain: [],
      },
    }));

    expect(screen.getByText("Company override is active.")).toBeTruthy();
    expect(
      screen.getByText(
        /newly started runs use the primary company target even when an agent has its own explicit adapter/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/automatic fallback only applies to classified rate-limit or quota failures/i),
    ).toBeTruthy();
  });
});
