---
title: "feat: Add Telegram notifier plugin"
type: feat
date: 2026-03-09
---

# feat: Add Telegram notifier plugin

## Overview

Add a Telegram notification channel to Paperclip, following the established notifier plugin pattern (webhook, Discord, ntfy). Sends event notifications to a Telegram chat via the Bot API's `sendMessage` endpoint.

## Proposed Solution

Replicate the proven notifier plugin structure. The Telegram plugin exports `type`, `label`, `send()`, and `testConnection()` — identical interface to all existing plugins. Uses MarkdownV2 formatting with plain text fallback for reliability.

**Config:** `{ botToken: string, chatId: string }`
**API:** `POST https://api.telegram.org/bot{token}/sendMessage`
**No SSRF concern:** Fixed Telegram API endpoint — no user-supplied URLs to validate.

## Acceptance Criteria

- [x] `packages/notifiers/telegram/` created with standard plugin structure
- [x] Plugin exports `type`, `label`, `send()`, `testConnection()`
- [x] `send()` formats events as MarkdownV2 messages with plain text fallback
- [x] `testConnection()` sends a test message and returns `{ ok, error? }`
- [x] `"telegram"` added to `NOTIFICATION_CHANNEL_TYPES` in `packages/shared/src/constants.ts`
- [x] Plugin registered in `server/src/notifications/registry.ts`
- [x] `botToken` added to `SENSITIVE_FIELDS` redaction map in `server/src/services/notification.ts`
- [x] `@paperclipai/notifier-telegram` added to `server/package.json` dependencies
- [x] 10-second fetch timeout with AbortController (consistent with other plugins)
- [x] TypeScript builds cleanly (`pnpm typecheck` from plugin dir)

## Technical Approach

### Files to Create

#### 1. `packages/notifiers/telegram/package.json`

```json
{
  "name": "@paperclipai/notifier-telegram",
  "version": "0.2.7",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "publishConfig": {
    "access": "public",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@paperclipai/shared": "workspace:*" },
  "devDependencies": { "@types/node": "^24.6.0", "typescript": "^5.7.3" }
}
```

#### 2. `packages/notifiers/telegram/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

#### 3. `packages/notifiers/telegram/src/index.ts`

**Implementation pattern** (mirrors Discord/ntfy):

```typescript
import type { NotificationEvent } from "@paperclipai/shared";

export const type = "telegram";
export const label = "Telegram";

// Event label mapping (same set as Discord/ntfy)
const EVENT_LABELS: Record<string, string> = {
  "agent.run.finished": "Agent Run Finished",
  "agent.run.failed": "Agent Run Failed",
  "agent.run.cancelled": "Agent Run Cancelled",
  "agent.status_changed": "Agent Status Changed",
  "approval.created": "Approval Requested",
  "approval.decided": "Approval Decided",
  "issue.created": "Issue Created",
  "issue.updated": "Issue Updated",
  "issue.comment.created": "Issue Comment Added",
  "cost_event.created": "Cost Event",
};

// Event emoji mapping for visual scanning
const EVENT_EMOJI: Record<string, string> = {
  "agent.run.finished": "✅",
  "agent.run.failed": "❌",
  "agent.run.cancelled": "⏹",
  "agent.status_changed": "🔄",
  "approval.created": "⏳",
  "approval.decided": "✋",
  "issue.created": "📋",
  "issue.updated": "📝",
  "issue.comment.created": "💬",
  "cost_event.created": "💰",
};

// MarkdownV2 requires escaping these characters
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function formatMessage(event: NotificationEvent): string {
  const emoji = EVENT_EMOJI[event.type] ?? "🔔";
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
      "✅ Paperclip notification channel connected successfully.",
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
```

### Files to Modify

#### 4. `packages/shared/src/constants.ts` (~line 247)

Add `"telegram"` to `NOTIFICATION_CHANNEL_TYPES`:

```typescript
export const NOTIFICATION_CHANNEL_TYPES = ["webhook", "discord", "ntfy", "telegram"] as const;
```

#### 5. `server/src/notifications/registry.ts`

Import and register the Telegram backend:

```typescript
import * as telegram from "@paperclipai/notifier-telegram";
// ...
const backendsByType = new Map<string, NotificationChannelBackend>([
  [webhook.type, webhook],
  [discord.type, discord],
  [ntfy.type, ntfy],
  [telegram.type, telegram],
]);
```

#### 6. `server/src/services/notification.ts` (~line 19)

Add Telegram to sensitive fields redaction:

```typescript
const SENSITIVE_FIELDS: Record<string, string[]> = {
  webhook: ["url", "secret"],
  discord: ["webhookUrl"],
  ntfy: ["topic"],
  telegram: ["botToken"],
};
```

#### 7. `server/package.json`

Add workspace dependency:

```json
"@paperclipai/notifier-telegram": "workspace:*"
```

### Key Design Decisions

1. **No SSRF check needed** — Unlike webhook/Discord/ntfy which accept user-supplied URLs, Telegram uses a fixed API endpoint. No `isBlockedUrl()` needed.

2. **MarkdownV2 with plain text fallback** — Try MarkdownV2 first for rich formatting (bold titles, emoji, inline code for errors). If Telegram rejects the message (e.g., malformed escaping), retry as plain text. This maximizes reliability.

3. **chatId as string** — Telegram accepts both numeric IDs and `@channel` usernames. Store and pass as string to support both formats.

4. **Redact botToken only** — chatId is the destination identifier (analogous to a channel name), not a secret. Only botToken grants API access and must be redacted.

5. **No retry queue** — Consistent with all existing plugins: single attempt, 10-second timeout, fire-and-forget. Errors logged but don't block.

## References

- Brainstorm: `docs/brainstorms/2026-03-09-telegram-notifier-brainstorm.md`
- Discord plugin (reference impl): `packages/notifiers/discord/src/index.ts`
- ntfy plugin (reference impl): `packages/notifiers/ntfy/src/index.ts`
- Registry: `server/src/notifications/registry.ts`
- Redaction logic: `server/src/services/notification.ts:19-47`
- Telegram Bot API docs: https://core.telegram.org/bots/api#sendmessage
