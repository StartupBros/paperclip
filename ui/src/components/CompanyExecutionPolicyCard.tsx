import { useEffect, useMemo, useState } from "react";
import type { Company, CompanyExecutionPolicy, ExecutionTarget } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { companiesApi } from "@/api/companies";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Field, HintIcon } from "./agent-config-primitives";
import { ExecutionTargetEditor } from "./ExecutionTargetEditor";

function clonePolicy(policy: CompanyExecutionPolicy | null | undefined): CompanyExecutionPolicy {
  return {
    mode: policy?.mode ?? "default",
    target: policy?.target
      ? {
          adapterType: policy.target.adapterType,
          adapterConfig: { ...policy.target.adapterConfig },
        }
      : null,
    fallbackChain: (policy?.fallbackChain ?? []).map((target) => ({
      adapterType: target.adapterType,
      adapterConfig: { ...target.adapterConfig },
    })),
  };
}

function createEmptyTarget(): ExecutionTarget {
  return {
    adapterType: "claude_local",
    adapterConfig: {},
  };
}

function normalizePolicyForSave(policy: CompanyExecutionPolicy): CompanyExecutionPolicy | null {
  const normalized: CompanyExecutionPolicy = {
    mode: policy.mode,
    target: policy.target
      ? {
          adapterType: policy.target.adapterType,
          adapterConfig: { ...policy.target.adapterConfig },
        }
      : null,
    fallbackChain: policy.fallbackChain.map((target) => ({
      adapterType: target.adapterType,
      adapterConfig: { ...target.adapterConfig },
    })),
  };
  if (!normalized.target && normalized.fallbackChain.length === 0) {
    return null;
  }
  return normalized;
}

function serializePolicy(policy: CompanyExecutionPolicy | null | undefined) {
  return JSON.stringify(normalizePolicyForSave(clonePolicy(policy)));
}

function omitValidityKey(validity: Record<string, boolean>, key: string) {
  const next = { ...validity };
  delete next[key];
  return next;
}

function reindexFallbackValidity(validity: Record<string, boolean>, removedIndex: number) {
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(validity)) {
    if (!key.startsWith("fallback-")) {
      next[key] = value;
      continue;
    }

    const suffix = Number(key.slice("fallback-".length));
    if (!Number.isInteger(suffix) || suffix < 0) {
      next[key] = value;
      continue;
    }
    if (suffix === removedIndex) {
      continue;
    }
    if (suffix > removedIndex) {
      next[`fallback-${suffix - 1}`] = value;
      continue;
    }
    next[key] = value;
  }
  return next;
}

interface CompanyExecutionPolicyCardProps {
  company: Company;
}

export function CompanyExecutionPolicyCard({ company }: CompanyExecutionPolicyCardProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CompanyExecutionPolicy>(() => clonePolicy(company.executionPolicy));
  const [validity, setValidity] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setDraft(clonePolicy(company.executionPolicy));
    setValidity({});
  }, [company.executionPolicy, company.id]);

  const dirty = useMemo(
    () => serializePolicy(draft) !== serializePolicy(company.executionPolicy),
    [company.executionPolicy, draft],
  );

  const hasInvalidEditor = Object.values(validity).some((value) => value === false);
  const saveDisabled = hasInvalidEditor || (draft.mode === "override" && !draft.target);

  const saveMutation = useMutation({
    mutationFn: () =>
      companiesApi.update(company.id, {
        executionPolicy: normalizePolicyForSave(draft),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  return (
    <div className="space-y-4 rounded-md border border-border px-4 py-4">
      <div className="flex items-center gap-1.5">
        <div className="text-xs text-muted-foreground">
          Select the primary company execution target and the fallback chain used for classified rate-limit failures.
        </div>
        <HintIcon text="Default mode fills in agents without an explicit adapter. Override mode wins for newly started runs across the company." />
      </div>

      <Field label="Resolution mode">
        <select
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          value={draft.mode}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              mode: event.target.value === "override" ? "override" : "default",
            }))
          }
        >
          <option value="default">Default: only fill agents without an explicit target</option>
          <option value="override">Override: force the company target for new runs</option>
        </select>
      </Field>

      {draft.mode === "override" ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-950 dark:text-amber-100">
          <div className="font-medium">Company override is active.</div>
          <div className="mt-1 text-xs">
            Newly started runs use the primary company target even when an agent has its own
            explicit adapter. Running runs keep the target they already resolved.
          </div>
          <div className="mt-1 text-xs">
            Automatic fallback only applies to classified rate-limit or quota failures.
          </div>
        </div>
      ) : null}

      {draft.target ? (
        <div className="space-y-2">
          <ExecutionTargetEditor
            companyId={company.id}
            label="Primary target"
            hint="This is the primary execution target selected by the company policy."
            value={draft.target}
            onChange={(target) => setDraft((current) => ({ ...current, target }))}
            onValidityChange={(valid) =>
              setValidity((current) => ({ ...current, target: valid }))
            }
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft((current) => ({ ...current, target: null }));
                setValidity((current) => omitValidityKey(current, "target"));
              }}
            >
              Remove primary target
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          <div>No primary company target configured.</div>
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft((current) => ({ ...current, target: createEmptyTarget() }))}
            >
              Set primary target
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Fallback chain</div>
            <div className="text-xs text-muted-foreground">
              Only used when a run fails with a classified rate-limit or quota failure.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                fallbackChain: [...current.fallbackChain, createEmptyTarget()],
              }))
            }
          >
            Add fallback
          </Button>
        </div>

        {draft.fallbackChain.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No fallback targets configured.
          </div>
        ) : (
          <div className="space-y-3">
            {draft.fallbackChain.map((target, index) => (
              <div key={`${target.adapterType}-${index}`} className="space-y-2">
                <ExecutionTargetEditor
                  companyId={company.id}
                  label={`Fallback ${index + 1}`}
                  value={target}
                  onChange={(nextTarget) =>
                    setDraft((current) => ({
                      ...current,
                      fallbackChain: current.fallbackChain.map((entry, entryIndex) =>
                        entryIndex === index ? nextTarget : entry,
                      ),
                    }))
                  }
                  onValidityChange={(valid) =>
                    setValidity((current) => ({ ...current, [`fallback-${index}`]: valid }))
                  }
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        fallbackChain: current.fallbackChain.filter((_, entryIndex) => entryIndex !== index),
                      }));
                      setValidity((current) => reindexFallbackValidity(current, index));
                    }}
                  >
                    Remove fallback
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(dirty || hasInvalidEditor || saveMutation.isError || saveMutation.isSuccess) && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || saveDisabled}
          >
            {saveMutation.isPending ? "Saving..." : "Save execution policy"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(clonePolicy(company.executionPolicy));
              setValidity({});
            }}
            disabled={saveMutation.isPending || (!dirty && !hasInvalidEditor)}
          >
            Reset
          </Button>
          {saveDisabled && (
            <span className="text-xs text-destructive">
              {hasInvalidEditor
                ? "Adapter config JSON must be valid before saving."
                : "Override mode requires a primary target."}
            </span>
          )}
          {saveMutation.isSuccess && !saveDisabled && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {saveMutation.isError && (
            <span className="text-xs text-destructive">
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : "Failed to save execution policy"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
