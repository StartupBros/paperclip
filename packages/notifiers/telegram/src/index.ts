import type { NotificationEvent } from "@paperclipai/shared";

export const type = "telegram";
export const label = "Telegram";

const EVENT_LABELS: Record<string, string> = {
  "agent.run.finished": "Agent Run Finished",
  "agent.run.failed": "Agent Run Failed",
  "agent.run.cancelled": "Agent Run Cancelled",
  "agent.status_changed": "Agent Status Changed",
  "approval.created": "Approval Requested",
  "approval.decided": "Approval Decided",
  "issue.created": "Issue Created",
  "issue.updated": "Issue Updated",
  "issue.comment.created": "New Comment",
  "cost_event.created": "Cost Event",
};

const EVENT_EMOJI: Record<string, string> = {
  "agent.run.finished": "\u2705",
  "agent.run.failed": "\u274C",
  "agent.run.cancelled": "\u23F9",
  "agent.status_changed": "\uD83D\uDD04",
  "approval.created": "\u23F3",
  "approval.decided": "\u270B",
  "issue.created": "\uD83D\uDCCB",
  "issue.updated": "\uD83D\uDCDD",
  "issue.comment.created": "\uD83D\uDCAC",
  "cost_event.created": "\uD83D\uDCB0",
};

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function formatMessage(event: NotificationEvent): string {
  const emoji = EVENT_EMOJI[event.type] ?? "\uD83D\uDD14";
  const title = EVENT_LABELS[event.type] ?? event.type;

  const lines: string[] = [
    `${emoji} *${escapeMarkdownV2(title)}*`,
    "",
    `*Actor:* ${escapeMarkdownV2(`${event.actor.type} (${event.actor.id})`)}`,
    `*Entity:* ${escapeMarkdownV2(`${event.entity.type} (${event.entity.id})`)}`,
  ];

  const status = event.payload.status as string | undefined;
  if (status) lines.push(`*Status:* ${escapeMarkdownV2(status)}`);

  const error = event.payload.error as string | undefined;
  if (error) lines.push(`*Error:* \`${escapeMarkdownV2(error.slice(0, 512))}\``);

  return lines.join("\n");
}

function formatPlainText(event: NotificationEvent): string {
  const title = EVENT_LABELS[event.type] ?? event.type;
  const lines = [
    title,
    `Actor: ${event.actor.type} (${event.actor.id})`,
    `Entity: ${event.entity.type} (${event.entity.id})`,
  ];
  const status = event.payload.status as string | undefined;
  if (status) lines.push(`Status: ${status}`);
  const error = event.payload.error as string | undefined;
  if (error) lines.push(`Error: ${error.slice(0, 512)}`);
  return lines.join("\n");
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: string,
): Promise<Response> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function send(
  event: NotificationEvent,
  config: Record<string, unknown>,
): Promise<void> {
  const botToken = config.botToken as string;
  const chatId = config.chatId as string;
  if (!botToken || !chatId) throw new Error("Missing botToken or chatId");

  // Try MarkdownV2 first, fall back to plain text
  let response = await sendTelegram(botToken, chatId, formatMessage(event), "MarkdownV2");
  if (!response.ok) {
    response = await sendTelegram(botToken, chatId, formatPlainText(event));
  }
  if (!response.ok) {
    throw new Error(`Telegram API returned ${response.status}`);
  }
}

export async function testConnection(
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const botToken = config.botToken as string;
  const chatId = config.chatId as string;
  if (!botToken) return { ok: false, error: "Missing botToken in config" };
  if (!chatId) return { ok: false, error: "Missing chatId in config" };

  try {
    const response = await sendTelegram(
      botToken,
      chatId,
      "\u2705 Paperclip notification channel connected successfully.",
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const desc = (body as { description?: string }).description ?? `HTTP ${response.status}`;
      return { ok: false, error: desc };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
