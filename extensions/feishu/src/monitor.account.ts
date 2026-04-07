import * as crypto from "crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import {
  handleFeishuMessage,
  parseFeishuMessageEvent,
  type FeishuMessageEvent,
  type FeishuBotAddedEvent,
} from "./bot.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";
import {
  createEventDispatcher,
  createFeishuClient,
  pluginVersion,
  setFeishuUserAgentMode,
} from "./client.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { isRecord, readString } from "./comment-shared.js";
import {
  hasProcessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
  warmupDedupFromDisk,
} from "./dedup.js";
import { isMentionForwardRequest } from "./mention.js";
import { applyBotIdentityState, startBotIdentityRecovery } from "./monitor.bot-identity.js";
import { parseFeishuDriveCommentNoticeEventPayload } from "./monitor.comment.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, sendCardFeishu } from "./send.js";
import { createFeishuThreadBindingManager } from "./thread-bindings.js";
import type { FeishuChatType, ResolvedFeishuAccount } from "./types.js";

const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1_500;

export type FeishuReactionCreatedEvent = {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: { open_id?: string };
  action_time?: string;
};

export type FeishuReactionDeletedEvent = FeishuReactionCreatedEvent & {
  reaction_id?: string;
};

type ResolveReactionSyntheticEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuReactionCreatedEvent;
  botOpenId?: string;
  fetchMessage?: typeof getMessageFeishu;
  verificationTimeoutMs?: number;
  logger?: (message: string) => void;
  uuid?: () => string;
  action?: "created" | "deleted";
};

export async function resolveReactionSyntheticEvent(
  params: ResolveReactionSyntheticEventParams,
): Promise<FeishuMessageEvent | null> {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    fetchMessage = getMessageFeishu,
    verificationTimeoutMs = FEISHU_REACTION_VERIFY_TIMEOUT_MS,
    logger,
    uuid = () => crypto.randomUUID(),
    action = "created",
  } = params;

  const emoji = event.reaction_type?.emoji_type;
  const messageId = event.message_id;
  const senderId = event.user_id?.open_id;
  if (!emoji || !messageId || !senderId) {
    return null;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const reactionNotifications = account.config.reactionNotifications ?? "own";
  if (reactionNotifications === "off") {
    return null;
  }

  if (event.operator_type === "app" || senderId === botOpenId) {
    return null;
  }

  if (emoji === "Typing") {
    return null;
  }

  if (reactionNotifications === "own" && !botOpenId) {
    logger?.(
      `feishu[${accountId}]: bot open_id unavailable, skipping reaction ${emoji} on ${messageId}`,
    );
    return null;
  }

  const reactedMsg = await raceWithTimeoutAndAbort(fetchMessage({ cfg, messageId, accountId }), {
    timeoutMs: verificationTimeoutMs,
  })
    .then((result) => (result.status === "resolved" ? result.value : null))
    .catch(() => null);
  const isBotMessage = reactedMsg?.senderType === "app" || reactedMsg?.senderOpenId === botOpenId;
  if (!reactedMsg || (reactionNotifications === "own" && !isBotMessage)) {
    logger?.(
      `feishu[${accountId}]: ignoring reaction on non-bot/unverified message ${messageId} ` +
        `(sender: ${reactedMsg?.senderOpenId ?? "unknown"})`,
    );
    return null;
  }

  const fallbackChatType = reactedMsg.chatType;
  const normalizedEventChatType = normalizeFeishuChatType(event.chat_type);
  const resolvedChatType = normalizedEventChatType ?? fallbackChatType;
  if (!resolvedChatType) {
    logger?.(
      `feishu[${accountId}]: skipping reaction ${emoji} on ${messageId} without chat type context`,
    );
    return null;
  }

  const syntheticChatIdRaw = event.chat_id ?? reactedMsg.chatId;
  const syntheticChatId = syntheticChatIdRaw?.trim() ? syntheticChatIdRaw : `p2p:${senderId}`;
  const syntheticChatType: FeishuChatType = resolvedChatType;
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:${uuid()}`,
      chat_id: syntheticChatId,
      chat_type: syntheticChatType,
      message_type: "text",
      content: JSON.stringify({
        text:
          action === "deleted"
            ? `[removed reaction ${emoji} from message ${messageId}]`
            : `[reacted with ${emoji} to message ${messageId}]`,
      }),
    },
  };
}

function normalizeFeishuChatType(value: unknown): FeishuChatType | undefined {
  return value === "group" || value === "private" || value === "p2p" ? value : undefined;
}

type RegisterEventHandlersContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
};

type FeishuBotMenuEvent = {
  event_key?: string;
  timestamp?: string | number;
  operator?: {
    operator_name?: string;
    operator_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
};

function readStringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function parseFeishuMessageEventPayload(value: unknown): FeishuMessageEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const sender = value.sender;
  const message = value.message;
  if (!isRecord(sender) || !isRecord(message)) {
    return null;
  }
  const senderId = sender.sender_id;
  if (!isRecord(senderId)) {
    return null;
  }
  const messageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const chatType = normalizeFeishuChatType(message.chat_type);
  const messageType = readString(message.message_type);
  const content = readString(message.content);
  if (!messageId || !chatId || !chatType || !messageType || !content) {
    return null;
  }
  return value as FeishuMessageEvent;
}

function parseFeishuBotAddedEventPayload(value: unknown): FeishuBotAddedEvent | null {
  if (!isRecord(value) || !readString(value.chat_id) || !isRecord(value.operator_id)) {
    return null;
  }
  return value as FeishuBotAddedEvent;
}

function parseFeishuBotRemovedChatId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return readString(value.chat_id) ?? null;
}

function parseFeishuBotMenuEvent(value: unknown): FeishuBotMenuEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = value.operator;
  if (operator !== undefined && !isRecord(operator)) {
    return null;
  }
  return {
    event_key: readString(value.event_key),
    timestamp: readStringOrNumber(value.timestamp),
    operator: operator
      ? {
          operator_name: readString(operator.operator_name),
          operator_id: isRecord(operator.operator_id)
            ? {
                open_id: readString(operator.operator_id.open_id),
                user_id: readString(operator.operator_id.user_id),
                union_id: readString(operator.operator_id.union_id),
              }
            : undefined,
        }
      : undefined,
  };
}

function parseFeishuCardActionEventPayload(value: unknown): FeishuCardActionEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = value.operator;
  const action = value.action;
  const context = value.context;
  if (!isRecord(operator) || !isRecord(action) || !isRecord(context)) {
    return null;
  }
  const token = readString(value.token);
  const openId = readString(operator.open_id);
  const userId = readString(operator.user_id);
  const unionId = readString(operator.union_id);
  const tag = readString(action.tag);
  const actionValue = action.value;
  const contextOpenId = readString(context.open_id);
  const contextUserId = readString(context.user_id);
  const chatId = readString(context.chat_id);
  if (
    !token ||
    !openId ||
    !userId ||
    !unionId ||
    !tag ||
    !isRecord(actionValue) ||
    !contextOpenId ||
    !contextUserId ||
    !chatId
  ) {
    return null;
  }
  return {
    operator: {
      open_id: openId,
      user_id: userId,
      union_id: unionId,
    },
    token,
    action: {
      value: actionValue,
      tag,
    },
    context: {
      open_id: contextOpenId,
      user_id: contextUserId,
      chat_id: chatId,
    },
  };
}

/**
 * Per-chat serial queue that ensures messages from the same chat are processed
 * in arrival order while allowing different chats to run concurrently.
 */
function createChatQueue() {
  const queues = new Map<string, Promise<void>>();
  return (chatId: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(chatId, next);
    void next.finally(() => {
      if (queues.get(chatId) === next) {
        queues.delete(chatId);
      }
    });
    return next;
  };
}

function mergeFeishuDebounceMentions(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent["message"]["mentions"] | undefined {
  const merged = new Map<string, NonNullable<FeishuMessageEvent["message"]["mentions"]>[number]>();
  for (const entry of entries) {
    for (const mention of entry.message.mentions ?? []) {
      const stableId =
        mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
      const mentionName = mention.name?.trim();
      const mentionKey = mention.key?.trim();
      const fallback =
        mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
      const key = stableId || fallback;
      if (!key || merged.has(key)) {
        continue;
      }
      merged.set(key, mention);
    }
  }
  if (merged.size === 0) {
    return undefined;
  }
  return Array.from(merged.values());
}

function dedupeFeishuDebounceEntriesByMessageId(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent[] {
  const seen = new Set<string>();
  const deduped: FeishuMessageEvent[] = [];
  for (const entry of entries) {
    const messageId = entry.message.message_id?.trim();
    if (!messageId) {
      deduped.push(entry);
      continue;
    }
    if (seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
    deduped.push(entry);
  }
  return deduped;
}

function resolveFeishuDebounceMentions(params: {
  entries: FeishuMessageEvent[];
  botOpenId?: string;
}): FeishuMessageEvent["message"]["mentions"] | undefined {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMentionForwardRequest(entry, botOpenId)) {
      // Keep mention-forward semantics scoped to a single source message.
      return mergeFeishuDebounceMentions([entry]);
    }
  }
  const merged = mergeFeishuDebounceMentions(entries);
  if (!merged) {
    return undefined;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return undefined;
  }
  const botMentions = merged.filter(
    (mention) => mention.id.open_id?.trim() === normalizedBotOpenId,
  );
  return botMentions.length > 0 ? botMentions : undefined;
}

function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: RegisterEventHandlersContext,
): void {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const core = getFeishuRuntime();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu",
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createChatQueue();
  const runFeishuHandler = async (params: { task: () => Promise<void>; errorMessage: string }) => {
    if (fireAndForget) {
      void params.task().catch((err) => {
        error(`${params.errorMessage}: ${String(err)}`);
      });
      return;
    }
    try {
      await params.task();
    } catch (err) {
      error(`${params.errorMessage}: ${String(err)}`);
    }
  };
  const dispatchFeishuMessage = async (event: FeishuMessageEvent) => {
    const chatId = event.message.chat_id?.trim() || "unknown";
    const task = () =>
      handleFeishuMessage({
        cfg,
        event,
        botOpenId: botOpenIds.get(accountId),
        botName: botNames.get(accountId),
        runtime,
        chatHistories,
        accountId,
        processingClaimHeld: true,
      });
    await enqueue(chatId, task);
  };
  const resolveSenderDebounceId = (event: FeishuMessageEvent): string | undefined => {
    const senderId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || undefined;
  };
  const resolveDebounceText = (event: FeishuMessageEvent): string => {
    const botOpenId = botOpenIds.get(accountId);
    const parsed = parseFeishuMessageEvent(event, botOpenId, botNames.get(accountId));
    return parsed.content.trim();
  };
  const recordSuppressedMessageIds = async (
    entries: FeishuMessageEvent[],
    dispatchMessageId?: string,
  ) => {
    const keepMessageId = dispatchMessageId?.trim();
    const suppressedIds = new Set(
      entries
        .map((entry) => entry.message.message_id?.trim())
        .filter((id): id is string => Boolean(id) && (!keepMessageId || id !== keepMessageId)),
    );
    if (suppressedIds.size === 0) {
      return;
    }
    for (const messageId of suppressedIds) {
      try {
        await recordProcessedFeishuMessage(messageId, accountId, log);
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`,
        );
      }
    }
  };
  const isMessageAlreadyProcessed = async (entry: FeishuMessageEvent): Promise<boolean> => {
    return await hasProcessedFeishuMessage(entry.message.message_id, accountId, log);
  };
  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<FeishuMessageEvent>({
    debounceMs: inboundDebounceMs,
    buildKey: (event) => {
      const chatId = event.message.chat_id?.trim();
      const senderId = resolveSenderDebounceId(event);
      if (!chatId || !senderId) {
        return null;
      }
      const rootId = event.message.root_id?.trim();
      const threadKey = rootId ? `thread:${rootId}` : "chat";
      return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (event) => {
      if (event.message.message_type !== "text") {
        return false;
      }
      const text = resolveDebounceText(event);
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await dispatchFeishuMessage(last);
        return;
      }
      const dedupedEntries = dedupeFeishuDebounceEntriesByMessageId(entries);
      const freshEntries: FeishuMessageEvent[] = [];
      for (const entry of dedupedEntries) {
        if (!(await isMessageAlreadyProcessed(entry))) {
          freshEntries.push(entry);
        }
      }
      const dispatchEntry = freshEntries.at(-1);
      if (!dispatchEntry) {
        return;
      }
      await recordSuppressedMessageIds(dedupedEntries, dispatchEntry.message.message_id);
      const combinedText = freshEntries
        .map((entry) => resolveDebounceText(entry))
        .filter(Boolean)
        .join("\n");
      const mergedMentions = resolveFeishuDebounceMentions({
        entries: freshEntries,
        botOpenId: botOpenIds.get(accountId),
      });
      if (!combinedText.trim()) {
        await dispatchFeishuMessage({
          ...dispatchEntry,
          message: {
            ...dispatchEntry.message,
            mentions: mergedMentions ?? dispatchEntry.message.mentions,
          },
        });
        return;
      }
      await dispatchFeishuMessage({
        ...dispatchEntry,
        message: {
          ...dispatchEntry.message,
          message_type: "text",
          content: JSON.stringify({ text: combinedText }),
          mentions: mergedMentions ?? dispatchEntry.message.mentions,
        },
      });
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        releaseFeishuMessageProcessing(entry.message.message_id, accountId);
      }
      error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
    },
  });

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      const event = parseFeishuMessageEventPayload(data);
      if (!event) {
        error(`feishu[${accountId}]: ignoring malformed message event payload`);
        return;
      }
      const messageId = event.message?.message_id?.trim();
      if (!tryBeginFeishuMessageProcessing(messageId, accountId)) {
        log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
        return;
      }
      const processMessage = async () => {
        await inboundDebouncer.enqueue(event);
      };
      if (fireAndForget) {
        void processMessage().catch((err) => {
          releaseFeishuMessageProcessing(messageId, accountId);
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        });
        return;
      }
      try {
        await processMessage();
      } catch (err) {
        releaseFeishuMessageProcessing(messageId, accountId);
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = parseFeishuBotAddedEventPayload(data);
        if (!event) {
          return;
        }
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const chatId = parseFeishuBotRemovedChatId(data);
        if (!chatId) {
          return;
        }
        log(`feishu[${accountId}]: bot removed from chat ${chatId}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
    "drive.notice.comment_add_v1": async (data: unknown) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling drive comment notice`,
        task: async () => {
          const event = parseFeishuDriveCommentNoticeEventPayload(data);
          if (!event) {
            error(`feishu[${accountId}]: ignoring malformed drive comment notice payload`);
            return;
          }
          const eventId = event.event_id?.trim();
          const syntheticMessageId = eventId ? `drive-comment:${eventId}` : undefined;
          if (
            syntheticMessageId &&
            (await hasProcessedFeishuMessage(syntheticMessageId, accountId, log))
          ) {
            log(`feishu[${accountId}]: dropping duplicate comment event ${syntheticMessageId}`);
            return;
          }
          if (
            syntheticMessageId &&
            !tryBeginFeishuMessageProcessing(syntheticMessageId, accountId)
          ) {
            log(`feishu[${accountId}]: dropping in-flight comment event ${syntheticMessageId}`);
            return;
          }
          log(
            `feishu[${accountId}]: received drive comment notice ` +
              `event=${event.event_id ?? "unknown"} ` +
              `type=${event.notice_meta?.notice_type ?? "unknown"} ` +
              `file=${event.notice_meta?.file_type ?? "unknown"}:${event.notice_meta?.file_token ?? "unknown"} ` +
              `comment=${event.comment_id ?? "unknown"} ` +
              `reply=${event.reply_id ?? "none"} ` +
              `from=${event.notice_meta?.from_user_id?.open_id ?? "unknown"} ` +
              `mentioned=${event.is_mentioned === true ? "yes" : "no"}`,
          );
          try {
            await handleFeishuCommentEvent({
              cfg,
              accountId,
              event,
              botOpenId: botOpenIds.get(accountId),
              runtime,
            });
            if (syntheticMessageId) {
              await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
            }
          } finally {
            if (syntheticMessageId) {
              releaseFeishuMessageProcessing(syntheticMessageId, accountId);
            }
          }
        },
      });
    },
    "im.message.reaction.created_v1": async (data) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction event`,
        task: async () => {
          const event = data as FeishuReactionCreatedEvent;
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event,
            botOpenId: myBotId,
            logger: log,
          });
          if (!syntheticEvent) {
            return;
          }
          const promise = handleFeishuMessage({
            cfg,
            event: syntheticEvent,
            botOpenId: myBotId,
            botName: botNames.get(accountId),
            runtime,
            chatHistories,
            accountId,
          });
          await promise;
        },
      });
    },
    "im.message.reaction.deleted_v1": async (data) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction removal event`,
        task: async () => {
          const event = data as FeishuReactionDeletedEvent;
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event,
            botOpenId: myBotId,
            logger: log,
            action: "deleted",
          });
          if (!syntheticEvent) {
            return;
          }
          const promise = handleFeishuMessage({
            cfg,
            event: syntheticEvent,
            botOpenId: myBotId,
            botName: botNames.get(accountId),
            runtime,
            chatHistories,
            accountId,
          });
          await promise;
        },
      });
    },
    "application.bot.menu_v6": async (data) => {
      try {
        const event = parseFeishuBotMenuEvent(data);
        if (!event) {
          return;
        }
        const operatorOpenId = event.operator?.operator_id?.open_id?.trim();
        const eventKey = event.event_key?.trim();
        if (!operatorOpenId || !eventKey) {
          return;
        }
        const syntheticEvent: FeishuMessageEvent = {
          sender: {
            sender_id: {
              open_id: operatorOpenId,
              user_id: event.operator?.operator_id?.user_id,
              union_id: event.operator?.operator_id?.union_id,
            },
            sender_type: "user",
          },
          message: {
            message_id: `bot-menu:${eventKey}:${event.timestamp ?? Date.now()}`,
            chat_id: `p2p:${operatorOpenId}`,
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({
              text: `/menu ${eventKey}`,
            }),
          },
        };
        const syntheticMessageId = syntheticEvent.message.message_id;
        if (await hasProcessedFeishuMessage(syntheticMessageId, accountId, log)) {
          log(`feishu[${accountId}]: dropping duplicate bot-menu event for ${syntheticMessageId}`);
          return;
        }
        if (!tryBeginFeishuMessageProcessing(syntheticMessageId, accountId)) {
          log(`feishu[${accountId}]: dropping in-flight bot-menu event for ${syntheticMessageId}`);
          return;
        }
        const handleLegacyMenu = () =>
          handleFeishuMessage({
            cfg,
            event: syntheticEvent,
            botOpenId: botOpenIds.get(accountId),
            botName: botNames.get(accountId),
            runtime,
            chatHistories,
            accountId,
            processingClaimHeld: true,
          });

        const promise = maybeHandleFeishuQuickActionMenu({
          cfg,
          eventKey,
          operatorOpenId,
          runtime,
          accountId,
        })
          .then(async (handledMenu) => {
            if (handledMenu) {
              await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
              releaseFeishuMessageProcessing(syntheticMessageId, accountId);
              return;
            }
            return await handleLegacyMenu();
          })
          .catch((err) => {
            releaseFeishuMessageProcessing(syntheticMessageId, accountId);
            throw err;
          });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
          });
          return;
        }
        await promise;
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
      }
    },
    "card.action.trigger": async (data: unknown) => {
      try {
        const event = parseFeishuCardActionEventPayload(data);
        if (!event) {
          error(`feishu[${accountId}]: ignoring malformed card action payload`);
          return;
        }
        const promise = handleFeishuCardAction({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
      }
    },
  });
}

export type BotOpenIdSource =
  | { kind: "prefetched"; botOpenId?: string; botName?: string }
  | { kind: "fetch" };

export type MonitorSingleAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  botOpenIdSource?: BotOpenIdSource;
};

// --- lark-cli upgrade notification (one-time) ---

const LARK_CLI_MIN_VERSION = "2026.4.0";

function resolveFeishuStateDir(): string {
  const stateOverride = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return path.join(stateOverride, "feishu");
  }
  return path.join(os.homedir(), ".openclaw", "feishu");
}

function resolveNotifiedRecordPath(): string {
  return path.join(resolveFeishuStateDir(), "lark-cli-upgrade-notified.json");
}

type NotifiedRecord = {
  version: string;
  userOpenId: string;
  notifiedAt: string;
};

function readNotifiedRecord(): NotifiedRecord | null {
  try {
    const raw = require("node:fs").readFileSync(resolveNotifiedRecordPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeNotifiedRecord(record: NotifiedRecord): Promise<void> {
  const filePath = resolveNotifiedRecordPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
}

function isVersionGte(current: string, minimum: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const c = parse(current);
  const m = parse(minimum);
  for (let i = 0; i < Math.max(c.length, m.length); i++) {
    const cv = c[i] ?? 0;
    const mv = m[i] ?? 0;
    if (cv > mv) {
      return true;
    }
    if (cv < mv) {
      return false;
    }
  }
  return true; // equal
}

function buildLarkCliUpgradeCard(domain: string | undefined): Record<string, unknown> {
  const isLark = domain === "lark";
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    header: {
      title: {
        tag: "plain_text",
        content: isLark
          ? "🎉 OpenClaw now supports lark-cli integration"
          : "🎉 OpenClaw 现已支持 lark-cli 集成",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: isLark
            ? "lark-cli is the official Lark CLI by larksuite. Once enabled, your bot can operate Lark resources on your behalf — not just as an app.\n\n" +
              "What you can do after enabling:\n" +
              "📄 Read/write Docs & Wiki as yourself\n" +
              "📅 View your calendar, create events, check availability\n" +
              "📊 Query and update Bitable records\n" +
              "📁 Manage Drive files and folders\n" +
              "💬 Search chat history and send messages\n" +
              "📋 Create and manage Tasks\n\n" +
              "Get started:\n" +
              "```\nnpx @lark-open/openclaw-lark-tools@1.0.38-alpha.3 identity switch --user -y\n```\n\n" +
              "[Learn more](https://github.com/larksuite/cli)"
            : "lark-cli 是飞书官方命令行工具。开启后，bot 不再局限于应用身份，可以代你直接操作飞书资源。\n\n" +
              "开启后你可以：\n" +
              "📄 以个人身份读写云文档、编辑知识库\n" +
              "📅 查看你的日历、创建日程、查询忙闲\n" +
              "📊 查询和更新多维表格数据\n" +
              "📁 管理云空间文件和文件夹\n" +
              "💬 搜索聊天记录、发送消息\n" +
              "📋 创建和管理飞书任务\n\n" +
              "一键开启：\n" +
              "```\nnpx @lark-open/openclaw-lark-tools@1.0.38-alpha.3 identity switch --user -y\n```\n\n" +
              "[了解更多](https://github.com/larksuite/cli)",
        },
      ],
    },
  };
}

export async function checkAndNotifyLarkCliUpgrade(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  domain: string | undefined;
  log: (...args: unknown[]) => void;
}): Promise<void> {
  const { cfg, accountId, domain, log } = params;
  try {
    // 1. Check if mode is already configured (user already migrated)
    const feishuCfg = (cfg as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined;
    const accountCfg = (feishuCfg?.feishu ?? feishuCfg?.[accountId]) as
      | Record<string, unknown>
      | undefined;
    if (accountCfg?.mode) {
      log(`feishu[${accountId}]: lark-cli upgrade notification skipped: mode already configured`);
      return;
    }

    // 2. Check if multi-account configured (lark-cli only supports single account)
    const accounts = (feishuCfg?.feishu as Record<string, unknown> | undefined)?.accounts;
    if (accounts && typeof accounts === "object" && Object.keys(accounts).length > 1) {
      log(`feishu[${accountId}]: lark-cli upgrade notification skipped: multi-account configured`);
      return;
    }

    // 3. Check if already notified (any record exists = never notify again)
    const existingRecord = readNotifiedRecord();
    if (existingRecord) {
      log(`feishu[${accountId}]: lark-cli upgrade notification skipped: already notified`);
      return;
    }

    // 4. Check version
    if (!isVersionGte(pluginVersion, LARK_CLI_MIN_VERSION)) {
      log(
        `feishu[${accountId}]: lark-cli upgrade notification skipped: version ${pluginVersion} below minimum ${LARK_CLI_MIN_VERSION}`,
      );
      return;
    }

    // 5. Resolve app owner via OAPI — only send to the owner
    let ownerOpenId: string | undefined;
    try {
      const account = resolveFeishuAccount({ cfg, accountId });
      if (!account.configured) {
        log(`feishu[${accountId}]: lark-cli upgrade notification skipped: account not configured`);
        return;
      }
      const appId = account.appId;
      if (!appId) {
        log(`feishu[${accountId}]: lark-cli upgrade notification skipped: no appId`);
        return;
      }
      const client = createFeishuClient(account) as {
        request: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const appResp = (await client.request({
        method: "GET",
        url: `/open-apis/application/v6/applications/${appId}`,
        data: {},
        params: { lang: "zh_cn", user_id_type: "open_id" },
        timeout: 10_000,
      })) as { data?: { app?: { owner?: { open_id?: string } } } };
      ownerOpenId = appResp.data?.app?.owner?.open_id;
    } catch (err) {
      log(
        `feishu[${accountId}]: lark-cli upgrade notification skipped: failed to resolve app owner (${String(err)})`,
      );
      return;
    }

    if (!ownerOpenId) {
      log(`feishu[${accountId}]: lark-cli upgrade notification skipped: app owner not found`);
      return;
    }

    // 6. Send notification to app owner only
    const card = buildLarkCliUpgradeCard(domain);
    let sent = false;

    try {
      await sendCardFeishu({
        cfg,
        to: `user:${ownerOpenId}`,
        card,
        accountId,
      });
      sent = true;
      log(`feishu[${accountId}]: lark-cli upgrade notification sent to owner ${ownerOpenId}`);
    } catch (err) {
      log(
        `feishu[${accountId}]: lark-cli upgrade notification failed for owner ${ownerOpenId}: ${String(err)}`,
      );
    }

    // 7. Write record only on success (retry on next startup if failed)
    if (sent) {
      const notifiedAt = new Intl.DateTimeFormat("sv-SE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZoneName: "longOffset",
      })
        .format(new Date())
        .replace(" ", "T")
        .replace(/\s*GMT/, "");
      await writeNotifiedRecord({ version: pluginVersion, userOpenId: ownerOpenId, notifiedAt });
    }
    log(`feishu[${accountId}]: lark-cli upgrade notification complete (sent=${sent})`);
  } catch (err) {
    // Never block plugin startup
    log(`feishu[${accountId}]: lark-cli upgrade check failed (non-fatal): ${String(err)}`);
  }
}

// --- end lark-cli upgrade notification ---

export async function monitorSingleAccount(params: MonitorSingleAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  // Set User-Agent appMode suffix from config (e.g. "bot" or "user")
  const appMode = (account.config as Record<string, unknown>).appMode as string | undefined;
  setFeishuUserAgentMode(appMode);

  const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
  const botIdentity =
    botOpenIdSource.kind === "prefetched"
      ? { botOpenId: botOpenIdSource.botOpenId, botName: botOpenIdSource.botName }
      : await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
  const { botOpenId } = applyBotIdentityState(accountId, botIdentity);
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  if (!botOpenId && !abortSignal?.aborted) {
    startBotIdentityRecovery({ account, accountId, runtime, abortSignal });
  }

  const connectionMode = account.config.connectionMode ?? "websocket";
  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }
  if (connectionMode === "webhook" && !account.encryptKey?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

  const warmupCount = await warmupDedupFromDisk(accountId, log);
  if (warmupCount > 0) {
    log(`feishu[${accountId}]: dedup warmup loaded ${warmupCount} entries from disk`);
  }

  // One-time lark-cli upgrade notification (non-blocking)
  void checkAndNotifyLarkCliUpgrade({ cfg, accountId, domain: account.config.domain, log });

  let threadBindingManager: ReturnType<typeof createFeishuThreadBindingManager> | null = null;
  try {
    const eventDispatcher = createEventDispatcher(account);
    const chatHistories = new Map<string, HistoryEntry[]>();
    threadBindingManager = createFeishuThreadBindingManager({ accountId, cfg });

    registerEventHandlers(eventDispatcher, {
      cfg,
      accountId,
      runtime,
      chatHistories,
      fireAndForget: true,
    });

    if (connectionMode === "webhook") {
      return await monitorWebhook({ account, accountId, runtime, abortSignal, eventDispatcher });
    }
    return await monitorWebSocket({ account, accountId, runtime, abortSignal, eventDispatcher });
  } finally {
    threadBindingManager?.stop();
  }
}
