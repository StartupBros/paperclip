import { useEffect, useMemo, useState } from "react";
import type { ExecutionTarget } from "@paperclipai/shared";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { adapterLabels, Field, HintIcon } from "./agent-config-primitives";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPrettyJson(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

function serializeTarget(value: ExecutionTarget) {
  return JSON.stringify(value);
}

interface ExecutionTargetEditorProps {
  companyId: string;
  label: string;
  hint?: string;
  value: ExecutionTarget;
  onChange: (value: ExecutionTarget) => void;
  onValidityChange?: (valid: boolean) => void;
}

export function ExecutionTargetEditor({
  companyId,
  label,
  hint,
  value,
  onChange,
  onValidityChange,
}: ExecutionTargetEditorProps) {
  const [adapterType, setAdapterType] = useState(value.adapterType);
  const [model, setModel] = useState(
    typeof value.adapterConfig.model === "string" ? value.adapterConfig.model : "",
  );
  const [configText, setConfigText] = useState(toPrettyJson(value.adapterConfig));
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    setAdapterType(value.adapterType);
    setModel(typeof value.adapterConfig.model === "string" ? value.adapterConfig.model : "");
    setConfigText(toPrettyJson(value.adapterConfig));
    setConfigError(null);
  }, [value]);

  const { data: adapterModels = [] } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType),
    enabled: Boolean(companyId),
  });

  const normalizedAdapterModels = useMemo(
    () => adapterModels.filter((entry) => typeof entry.id === "string" && entry.id.length > 0),
    [adapterModels],
  );

  useEffect(() => {
    try {
      const parsed = JSON.parse(configText) as unknown;
      if (!isPlainObject(parsed)) {
        throw new Error("Adapter config must be a JSON object.");
      }
      const nextConfig = { ...parsed };
      if (model.trim()) {
        nextConfig.model = model.trim();
      } else {
        delete nextConfig.model;
      }
      setConfigError(null);
      onValidityChange?.(true);
      const nextTarget = {
        adapterType,
        adapterConfig: nextConfig,
      };
      if (serializeTarget(nextTarget) !== serializeTarget(value)) {
        onChange(nextTarget);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Adapter config must be valid JSON.";
      setConfigError(message);
      onValidityChange?.(false);
    }
  }, [adapterType, configText, model, onChange, onValidityChange, value]);

  return (
    <div className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-center gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        {hint ? <HintIcon text={hint} /> : null}
      </div>

      <Field label="Adapter type">
        <select
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          value={adapterType}
          onChange={(event) =>
            setAdapterType(event.target.value as (typeof AGENT_ADAPTER_TYPES)[number])
          }
        >
          {AGENT_ADAPTER_TYPES.map((type) => (
            <option key={type} value={type}>
              {adapterLabels[type] ?? type}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={normalizedAdapterModels.length > 0 ? "Model" : "Model override"}
        hint="Paperclip persists this under adapterConfig.model. Leave blank to use the adapter default."
      >
        {normalizedAdapterModels.length > 0 ? (
          <select
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Adapter default</option>
            {normalizedAdapterModels.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label || entry.id}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="provider/model or adapter default"
          />
        )}
      </Field>

      <Field
        label="Adapter config JSON"
        hint="Persisted exactly as company execution policy adapterConfig. Secret refs are allowed."
      >
        <textarea
          className="min-h-36 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
          value={configText}
          onChange={(event) => setConfigText(event.target.value)}
          spellCheck={false}
        />
      </Field>

      {configError ? (
        <p className="text-xs text-destructive">{configError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Paperclip stores the exact resolved target snapshot on each run before execution.
        </p>
      )}
    </div>
  );
}
