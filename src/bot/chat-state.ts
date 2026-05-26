import type { PiSessionContext } from "../pi-session.js";
import { getPiSessionContextKey } from "../pi-session.js";

export interface BotChatState {
  isLocallyBusy(target: PiSessionContext): boolean;
  isSteeringModeEnabled(target: PiSessionContext): boolean;
  toggleSteeringMode(target: PiSessionContext): boolean;
  isLiveToolOutputEnabled(target: PiSessionContext): boolean;
  toggleLiveToolOutput(target: PiSessionContext): boolean;
  beginProcessing(target: PiSessionContext, promptText: string): void;
  endProcessing(target: PiSessionContext): void;
  beginSwitching(target: PiSessionContext): void;
  endSwitching(target: PiSessionContext): void;
  beginTranscribing(target: PiSessionContext): void;
  endTranscribing(target: PiSessionContext): void;
  getLastPrompt(target: PiSessionContext): string | undefined;
  clearPromptMemory(target: PiSessionContext): void;
}

export function createBotChatState(): BotChatState {
  const processingContexts = new Set<string>();
  const switchingContexts = new Set<string>();
  const transcribingContexts = new Set<string>();
  const steeringModes = new Set<string>();
  const liveToolOutputs = new Set<string>();
  const lastPrompts = new Map<string, string>();

  const getContextKey = (target: PiSessionContext): string => getPiSessionContextKey(target);

  return {
    isLocallyBusy(target) {
      const contextKey = getContextKey(target);
      return (
        processingContexts.has(contextKey) ||
        switchingContexts.has(contextKey) ||
        transcribingContexts.has(contextKey)
      );
    },

    isSteeringModeEnabled(target) {
      return steeringModes.has(getContextKey(target));
    },

    toggleSteeringMode(target) {
      const contextKey = getContextKey(target);
      if (steeringModes.has(contextKey)) {
        steeringModes.delete(contextKey);
        return false;
      } else {
        steeringModes.add(contextKey);
        return true;
      }
    },

    isLiveToolOutputEnabled(target) {
      return liveToolOutputs.has(getContextKey(target));
    },

    toggleLiveToolOutput(target) {
      const contextKey = getContextKey(target);
      if (liveToolOutputs.has(contextKey)) {
        liveToolOutputs.delete(contextKey);
        return false;
      } else {
        liveToolOutputs.add(contextKey);
        return true;
      }
    },

    beginProcessing(target, promptText) {
      const contextKey = getContextKey(target);
      processingContexts.add(contextKey);
      lastPrompts.set(contextKey, promptText);
    },

    endProcessing(target) {
      processingContexts.delete(getContextKey(target));
    },

    beginSwitching(target) {
      switchingContexts.add(getContextKey(target));
    },

    endSwitching(target) {
      switchingContexts.delete(getContextKey(target));
    },

    beginTranscribing(target) {
      transcribingContexts.add(getContextKey(target));
    },

    endTranscribing(target) {
      transcribingContexts.delete(getContextKey(target));
    },

    getLastPrompt(target) {
      return lastPrompts.get(getContextKey(target));
    },

    clearPromptMemory(target) {
      lastPrompts.delete(getContextKey(target));
    },
  };
}
