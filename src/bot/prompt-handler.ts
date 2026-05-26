import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";

import { formatError } from "../errors.js";
import {
  appendWithCap,
  buildStreamingPreview,
  formatToolSummaryLine,
  isMessageNotModifiedError,
  renderExtensionError,
  renderExtensionNotice,
  renderPromptFailure,
  renderToolEndMessage,
  renderToolStartMessage,
  renderMarkdownChunkWithinLimit,
  splitMarkdownForTelegram,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type RenderedChunk,
  type RenderedText,
} from "./message-rendering.js";
import {
  safeEditMessage,
  safeReply,
  sendChatAction,
  sendTextMessage,
} from "./telegram-transport.js";
import { createTelegramUIContext } from "../telegram-ui-context.js";
import type { ToolVerbosity } from "../config.js";
import type { ExtensionDialogManager } from "./extension-dialogs.js";
import type { ChatTaskRunner } from "./chat-task-runner.js";
import type { PiSessionContext, PiSessionService } from "../pi-session.js";

export type HandleUserPrompt = (
  ctx: Context,
  target: PiSessionContext,
  userText: string,
  preloadedSlashCommands?: SlashCommandInfo[],
  images?: ImageContent[],
) => Promise<boolean>;

interface CreatePromptHandlerOptions {
  bot: Bot<Context>;
  getToolVerbosity: (target: PiSessionContext) => ToolVerbosity;
  editDebounceMs: number;
  typingIntervalMs: number;
  isBusy: (target: PiSessionContext) => boolean;
  isSteeringModeEnabled: (target: PiSessionContext) => boolean;
  taskRunner: ChatTaskRunner;
  ensureActiveSession: (ctx: Context, target: PiSessionContext) => Promise<PiSessionService | undefined>;
  syncChatScopedCommands: (target: PiSessionContext, slashCommands: SlashCommandInfo[]) => Promise<void>;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  extensionDialogs: Pick<ExtensionDialogManager, "openSelect" | "openConfirm" | "openInput">;
  sendBusyReply: (ctx: Context) => Promise<void>;
}

type PromptFlowDeps = Omit<CreatePromptHandlerOptions, "isBusy" | "isSteeringModeEnabled" | "taskRunner" | "sendBusyReply">;

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

async function runPromptFlow(
  deps: PromptFlowDeps,
  ctx: Context,
  target: PiSessionContext,
  userText: string,
  preloadedSlashCommands?: SlashCommandInfo[],
  images?: ImageContent[],
): Promise<void> {
  const {
    bot,
    getToolVerbosity,
    editDebounceMs,
    typingIntervalMs,
    ensureActiveSession,
    syncChatScopedCommands,
    refreshChatScopedCommands,
    extensionDialogs,
  } = deps;

  const piSession = await ensureActiveSession(ctx, target);
  if (!piSession) {
    return;
  }

  try {
    piSession.getSession().sessionManager.appendCustomEntry("telepi_target", {
      chatId: target.chatId,
      threadId: target.messageThreadId,
    });
  } catch (error) {
    console.error("Failed to append telepi_target entry", error);
  }

  const previousStats = piSession.getSessionStats();
  const previousCost = previousStats?.cost ?? 0;

  const slashCommands = preloadedSlashCommands;
  if (slashCommands) {
    void syncChatScopedCommands(target, slashCommands).catch((error) => {
      console.error("Failed to sync chat-scoped Telegram commands", error);
    });
  } else {
    void refreshChatScopedCommands(target, piSession);
  }

  const abortKeyboard = new InlineKeyboard().text("⏹ Abort", "pi_abort");
  const toolStates = new Map<string, ToolState>();
  const toolCounts = new Map<string, number>();
  let accumulatedText = "";
  let responseMessageId: number | undefined;
  let responseMessagePromise: Promise<void> | undefined;
  let lastRenderedText = "";
  let lastEditAt = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  let isFlushing = false;
  let flushPending = false;
  let finalized = false;
  const toolVerbosity = getToolVerbosity(target);

  const typingInterval = setInterval(() => {
    void sendChatAction(bot.api, target, "typing").catch(() => {});
  }, typingIntervalMs);
  void sendChatAction(bot.api, target, "typing").catch(() => {});

  const stopTyping = (): void => {
    clearInterval(typingInterval);
  };

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const renderPreview = (): RenderedChunk => {
    const previewText = buildStreamingPreview(accumulatedText || "_Processing..._");
    return renderMarkdownChunkWithinLimit(previewText);
  };

  const buildFinalResponseText = (text: string): string => {
    if (toolVerbosity !== "summary") {
      return text.trim();
    }

    const summaryLine = formatToolSummaryLine(toolCounts);
    const trimmedText = text.trim();
    if (!summaryLine) {
      return trimmedText;
    }

    return trimmedText ? `${trimmedText}\n\n${summaryLine}` : summaryLine;
  };

  const ensureResponseMessage = async (): Promise<void> => {
    if (responseMessageId) {
      return;
    }
    if (responseMessagePromise) {
      await responseMessagePromise;
      return;
    }

    responseMessagePromise = (async () => {
      const preview = renderPreview();
      const message = await sendTextMessage(bot.api, target, preview.text, {
        parseMode: preview.parseMode,
        fallbackText: preview.fallbackText,
        replyMarkup: abortKeyboard,
      });
      responseMessageId = message.message_id;
      lastRenderedText = preview.text;
      lastEditAt = Date.now();
      void sendChatAction(bot.api, target, "typing").catch(() => {});
    })();

    try {
      await responseMessagePromise;
    } finally {
      responseMessagePromise = undefined;
    }
  };

  const flushResponse = async (force = false): Promise<void> => {
    if (!accumulatedText && !force) {
      return;
    }
    if (!responseMessageId) {
      await ensureResponseMessage();
      return;
    }
    if (isFlushing) {
      flushPending = true;
      return;
    }

    const now = Date.now();
    if (!force && now - lastEditAt < editDebounceMs) {
      return;
    }

    const nextText = renderPreview();
    if (nextText.text === lastRenderedText) {
      return;
    }

    isFlushing = true;
    try {
      await safeEditMessage(bot, target, responseMessageId, nextText.text, {
        parseMode: nextText.parseMode,
        fallbackText: nextText.fallbackText,
        replyMarkup: abortKeyboard,
      });
      lastRenderedText = nextText.text;
      lastEditAt = Date.now();
    } finally {
      isFlushing = false;
      if (flushPending) {
        flushPending = false;
        scheduleFlush();
      }
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer || finalized) {
      return;
    }

    const delay = Math.max(0, editDebounceMs - (Date.now() - lastEditAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushResponse().catch((error) => {
        console.error("Failed to update Telegram response message", error);
      });
    }, delay);
  };

  const removeAbortKeyboard = async (): Promise<void> => {
    if (!responseMessageId) {
      return;
    }

    try {
      await bot.api.editMessageReplyMarkup(target.chatId, responseMessageId, {
        reply_markup: new InlineKeyboard(),
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        console.error("Failed to clear Abort button", error);
      }
    }
  };

  const deliverRenderedChunks = async (chunks: RenderedChunk[], lastChunkReplyMarkup?: InlineKeyboard): Promise<void> => {
    if (chunks.length === 0) {
      return;
    }

    const [firstChunk, ...remainingChunks] = chunks;
    const isOnlyChunk = remainingChunks.length === 0;
    const firstChunkMarkup = isOnlyChunk && lastChunkReplyMarkup ? lastChunkReplyMarkup : new InlineKeyboard();

    if (responseMessageId) {
      await safeEditMessage(bot, target, responseMessageId, firstChunk.text, {
        parseMode: firstChunk.parseMode,
        fallbackText: firstChunk.fallbackText,
        replyMarkup: firstChunkMarkup,
      });
    } else {
      const message = await sendTextMessage(bot.api, target, firstChunk.text, {
        parseMode: firstChunk.parseMode,
        fallbackText: firstChunk.fallbackText,
        replyMarkup: firstChunkMarkup,
      });
      responseMessageId = message.message_id;
    }

    for (let i = 0; i < remainingChunks.length; i++) {
      const chunk = remainingChunks[i];
      const isLast = i === remainingChunks.length - 1;
      const chunkMarkup = isLast ? lastChunkReplyMarkup : undefined;
      await sendTextMessage(bot.api, target, chunk.text, {
        parseMode: chunk.parseMode,
        fallbackText: chunk.fallbackText,
        replyMarkup: chunkMarkup,
      });
    }
  };

  const finalizeResponse = async (): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;

    stopTyping();
    clearFlushTimer();
    if (responseMessagePromise) {
      try {
        await responseMessagePromise;
      } catch {
        // If the initial send failed, we will fall back to sending the final response below.
      }
    }

    const finalStats = piSession.getSessionStats();
    const finalUsage = piSession.getContextUsage();
    let statsFooter = "";
    if (finalStats && finalUsage) {
      const currentCost = finalStats.cost;
      const turnCost = currentCost - previousCost;
      const contextPercent = finalUsage.percent != null ? Math.round(finalUsage.percent) : 0;
      statsFooter = `\n\n_Context: ${contextPercent}% | Cost: $${currentCost.toFixed(3)} (+$${Math.max(0, turnCost).toFixed(3)})_`;
    }

    const finalText = buildFinalResponseText(accumulatedText);
    const textWithFooter = finalText ? `${finalText}${statsFooter}` : statsFooter;
    const keyboard = new InlineKeyboard()
      .text("🗜️ Compact Session", "pi_compact")
      .text("🔊 Read Aloud", "pi_tts_play");

    if (!textWithFooter) {
      const html = "<b>✅ Done</b>";
      const plainText = "✅ Done";

      if (responseMessageId) {
        await safeEditMessage(bot, target, responseMessageId, html, { fallbackText: plainText, replyMarkup: keyboard });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText, replyMarkup: keyboard }, target);
      }
      return;
    }

    await deliverRenderedChunks(splitMarkdownForTelegram(textWithFooter), keyboard);
  };

  await piSession.bindExtensions({
    commandContextActions: {
      waitForIdle: async () => {
        await piSession.getSession().agent.waitForIdle();
      },
      newSession: async (options) => {
        const result = await piSession.newSession(options);
        return { cancelled: !result.created };
      },
      fork: async (entryId, forkOptions) => piSession.fork(entryId, forkOptions),
      navigateTree: async (targetId, navOptions) => {
        const result = await piSession.navigateTree(targetId, navOptions);
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, switchOptions) => {
        const result = await piSession.switchSession(sessionPath, switchOptions);
        return { cancelled: result.cancelled };
      },
      reload: async () => {
        await piSession.reload();
      },
    },
    uiContext: createTelegramUIContext({
      notify: (message, type) => {
        const rendered = renderExtensionNotice(message, type);
        void sendTextMessage(bot.api, target, rendered.text, {
          parseMode: rendered.parseMode,
          fallbackText: rendered.fallbackText,
        }).catch((error) => {
          console.error("Failed to send extension notification", error);
        });
      },
      select: (title, choices, dialogOptions) => extensionDialogs.openSelect(target, title, choices, dialogOptions),
      confirm: (title, message, dialogOptions) => extensionDialogs.openConfirm(target, title, message, dialogOptions),
      input: (title, placeholder, dialogOptions) => extensionDialogs.openInput(target, title, placeholder, dialogOptions),
    }),
    onError: (error) => {
      const rendered = renderExtensionError(error.extensionPath, error.event, error.error);
      void sendTextMessage(bot.api, target, rendered.text, {
        parseMode: rendered.parseMode,
        fallbackText: rendered.fallbackText,
      }).catch((sendError) => {
        console.error("Failed to send extension error", sendError);
      });
    },
  });

  void ensureResponseMessage().catch((error) => {
    console.error("Failed to send initial Telegram response message", error);
  });

  const unsubscribe = piSession.subscribe({
    onTextDelta: (delta) => {
      accumulatedText += delta;
      if (!responseMessageId) {
        void ensureResponseMessage()
          .then(() => {
            scheduleFlush();
          })
          .catch((error) => {
            console.error("Failed to send initial Telegram response message", error);
          });
        return;
      }

      scheduleFlush();
    },
    onToolStart: (toolName, toolCallId) => {
      if (toolVerbosity === "summary") {
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        return;
      }

      if (toolVerbosity === "none") {
        return;
      }

      toolStates.set(toolCallId, { toolName, partialResult: "" });
      if (toolVerbosity !== "all") {
        return;
      }

      const messageText = renderToolStartMessage(toolName);

      void (async () => {
        const message = await sendTextMessage(bot.api, target, messageText.text, {
          parseMode: messageText.parseMode,
          fallbackText: messageText.fallbackText,
        });
        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.messageId = message.message_id;
        if (state.finalStatus) {
          await safeEditMessage(bot, target, state.messageId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
          });
        }
      })().catch((error) => {
        console.error(`Failed to send tool start message for ${toolName}`, error);
      });
    },
    onToolUpdate: (toolCallId, partialResult) => {
      if (toolVerbosity === "none" || toolVerbosity === "summary") {
        return;
      }

      const state = toolStates.get(toolCallId);
      if (!state || !partialResult) {
        return;
      }

      state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
    },
    onToolEnd: (toolCallId, isError) => {
      if (toolVerbosity === "none" || toolVerbosity === "summary") {
        return;
      }

      const state = toolStates.get(toolCallId);
      if (!state) {
        return;
      }

      state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
      if (toolVerbosity === "errors-only") {
        if (!isError) {
          return;
        }

        void sendTextMessage(bot.api, target, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to send tool error message for ${state.toolName}`, error);
        });
        return;
      }

      if (!state.messageId) {
        return;
      }

      void safeEditMessage(bot, target, state.messageId, state.finalStatus.text, {
        parseMode: state.finalStatus.parseMode,
        fallbackText: state.finalStatus.fallbackText,
      }).catch((error) => {
        console.error(`Failed to update tool message for ${state.toolName}`, error);
      });
    },
    onAgentEnd: () => {
      void finalizeResponse().catch((error) => {
        console.error("Failed to finalize Telegram response message", error);
      });
    },
  });

  try {
    if (images && images.length > 0) {
      await piSession.prompt(userText, images);
    } else {
      await piSession.prompt(userText);
    }
    await finalizeResponse();
  } catch (error) {
    stopTyping();
    clearFlushTimer();
    if (responseMessagePromise) {
      try {
        await responseMessagePromise;
      } catch {
        // Ignore; we will send an error message below.
      }
    }

    if (finalized) {
      console.error("Pi prompt error after finalization:", formatError(error));
    } else {
      finalized = true;

      const finalStats = piSession.getSessionStats();
      const finalUsage = piSession.getContextUsage();
      let statsFooter = "";
      if (finalStats && finalUsage) {
        const currentCost = finalStats.cost;
        const turnCost = currentCost - previousCost;
        const contextPercent = finalUsage.percent != null ? Math.round(finalUsage.percent) : 0;
        statsFooter = `\n\n_Context: ${contextPercent}% | Cost: $${currentCost.toFixed(3)} (+$${Math.max(0, turnCost).toFixed(3)})_`;
      }

      const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
      const textWithFooter = combinedText ? `${combinedText}${statsFooter}` : statsFooter;
      const chunks = splitMarkdownForTelegram(textWithFooter);
      const keyboard = new InlineKeyboard()
        .text("🗜️ Compact Session", "pi_compact")
        .text("🔊 Read Aloud", "pi_tts_play");

      try {
        await deliverRenderedChunks(chunks, keyboard);
      } catch (telegramError) {
        console.error("Failed to send error message to Telegram:", telegramError);
      }
    }
  } finally {
    stopTyping();
    clearFlushTimer();
    unsubscribe();
  }
}

export function createPromptHandler(options: CreatePromptHandlerOptions): HandleUserPrompt {
  const {
    isBusy,
    isSteeringModeEnabled,
    taskRunner,
    sendBusyReply,
    ensureActiveSession,
    ...promptFlowDeps
  } = options;

  return async (
    ctx: Context,
    target: PiSessionContext,
    userText: string,
    preloadedSlashCommands?: SlashCommandInfo[],
    images?: ImageContent[],
  ): Promise<boolean> => {
    if (isBusy(target)) {
      if (isSteeringModeEnabled(target)) {
        const piSession = await ensureActiveSession(ctx, target);
        if (piSession?.hasActiveSession()) {
          const agentSession = piSession.getSession();
          if (agentSession.isStreaming) {
            try {
              if (images && images.length > 0) {
                await agentSession.steer(userText, images);
              } else {
                await agentSession.steer(userText);
              }
              const html = "<i>Mid-flight steering instructions sent to agent.</i>";
              const plain = "Mid-flight steering instructions sent to agent.";
              await sendTextMessage(ctx.api, target, html, { parseMode: "HTML", fallbackText: plain });
              return true;
            } catch (error) {
              console.error("Failed to steer prompt", error);
            }
          }
        }
      }

      await sendBusyReply(ctx);
      return false;
    }

    const result = taskRunner.tryStartPrompt(
      target,
      userText,
      () => runPromptFlow({ ensureActiveSession, ...promptFlowDeps }, ctx, target, userText, preloadedSlashCommands, images),
    );
    if (result === "busy") {
      await sendBusyReply(ctx);
      return false;
    }

    return true;
  };
}
