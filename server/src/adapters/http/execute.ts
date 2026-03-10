import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

function classifyHttpFailure(message: string): "rate_limit" | "provider" {
  const lower = message.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota") ||
    lower.includes("429")
  ) {
    return "rate_limit";
  }
  return "provider";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "HTTP adapter missing url",
      errorCode: "http_url_missing",
      failureCategory: "config",
    };
  }

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      const errorMessage = `HTTP invoke failed with status ${res.status}`;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage,
        errorCode: "http_status_error",
        failureCategory: classifyHttpFailure(errorMessage),
        resultJson: {
          status: res.status,
          statusText: res.statusText,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "HTTP invoke failed";
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      errorMessage,
      errorCode: timedOut ? "timeout" : "http_request_failed",
      failureCategory: timedOut ? "timeout" : classifyHttpFailure(errorMessage),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
