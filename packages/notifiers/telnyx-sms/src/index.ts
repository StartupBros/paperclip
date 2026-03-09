import type { NotificationEvent } from "@paperclipai/shared";

export const type = "telnyx_sms";
export const label = "Telnyx SMS";

// Telnyx Messaging API v2 endpoint
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// Map event types to human-readable labels
const EVENT_LABELS: Record<string, string> = {
  "agent.run.finished": "✅ Agent Run Finished",
  "agent.run.failed": "🚨 Agent Run Failed",
  "agent.run.cancelled": "⛔ Agent Run Cancelled",
  "agent.status_changed": "🔄 Agent Status Changed",
  "approval.created": "✋ Approval Requested",
  "approval.decided": "☑️ Approval Decided",
  "issue.created": "📝 Issue Created",
  "issue.updated": "✏️ Issue Updated",
  "issue.comment.created": "💬 New Comment",
  "cost_event.created": "💰 Cost Event",
};

// Build a concise SMS body (SMS has 160-char segments, keep it tight)
function buildSmsBody(event: NotificationEvent): string {
  const label = EVENT_LABELS[event.type] ?? event.type;
  const actor = `${event.actor.type}:${event.actor.id}`;

  const parts = [label, `Actor: ${actor}`];

  const status = event.payload.status as string | undefined;
  if (status) parts.push(`Status: ${status}`);

  const error = event.payload.error as string | undefined;
  if (error) parts.push(`Error: ${error.slice(0, 80)}`);

  // Keep total message under ~320 chars (2 SMS segments max)
  const msg = parts.join(" | ");
  return msg.length > 320 ? msg.slice(0, 317) + "..." : msg;
}

export async function send(
  event: NotificationEvent,
  config: Record<string, unknown>,
): Promise<void> {
  const apiKey = config.apiKey as string;
  if (!apiKey) throw new Error("Missing apiKey in config");

  const from = config.from as string;
  if (!from) throw new Error("Missing 'from' phone number or messaging profile ID in config");

  const to = config.to as string;
  if (!to) throw new Error("Missing 'to' phone number in config");

  const body: Record<string, unknown> = {
    to,
    text: buildSmsBody(event),
  };

  // Support both phone number and messaging_profile_id as the sender
  if (from.startsWith("+")) {
    body.from = from;
  } else {
    body.messaging_profile_id = from;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${TELNYX_API_BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Telnyx API returned ${response.status}: ${errBody.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function testConnection(
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = config.apiKey as string;
  if (!apiKey) return { ok: false, error: "Missing apiKey in config" };

  const from = config.from as string;
  if (!from) return { ok: false, error: "Missing 'from' phone number or messaging profile ID" };

  const to = config.to as string;
  if (!to) return { ok: false, error: "Missing 'to' phone number" };

  const body: Record<string, unknown> = {
    to,
    text: "Paperclip notification channel connected successfully. ✅",
  };

  if (from.startsWith("+")) {
    body.from = from;
  } else {
    body.messaging_profile_id = from;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${TELNYX_API_BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      return { ok: false, error: `HTTP ${response.status}: ${errBody.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
