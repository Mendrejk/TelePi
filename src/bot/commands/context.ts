import { InlineKeyboard, type Context } from "grammy";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionService } from "../../pi-session.js";
import { renderContextUsageHTML, renderContextUsagePlain, renderSessionStatsHTML, renderSessionStatsPlain, renderFailedText } from "../message-rendering.js";
import type { TextOptions } from "../telegram-transport.js";

export function createContextCommandHandlers(deps: {
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
}) {
  const { getExistingSession, safeReply } = deps;

  const handleContextCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const piSession = getExistingSession(target);

    if (!piSession?.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session. Context usage is not available."), {
        fallbackText: "No active session. Context usage is not available.",
      }, target);
      return;
    }

    const usage = piSession.getContextUsage();
    const stats = piSession.getSessionStats();

    if (!usage) {
      await safeReply(ctx, escapeHTML("Context usage is not yet available. Send a prompt first."), {
        fallbackText: "Context usage is not yet available. Send a prompt first.",
      }, target);
      return;
    }

    const usagePlain = renderContextUsagePlain(usage);
    const usageHTML = renderContextUsageHTML(usage);

    let statsPlain = "";
    let statsHTML = "";
    if (stats) {
      statsPlain = `\n\n${renderSessionStatsPlain(stats)}`;
      statsHTML = `\n\n${renderSessionStatsHTML(stats)}`;
    }

    const plainText = `Context Usage${statsPlain ? "\n\nSession Stats" : ""}\n\n${usagePlain}${statsPlain}`;
    const html = `<b>Context Usage</b>${statsHTML ? "\n\n<b>Session Stats</b>" : ""}\n\n${usageHTML}${statsHTML}`;

    const keyboard = new InlineKeyboard().text("🗜️ Compact Session", "pi_compact");

    await safeReply(ctx, html, { fallbackText: plainText, replyMarkup: keyboard }, target);
  };

  return {
    handleContextCommand,
  };
}
