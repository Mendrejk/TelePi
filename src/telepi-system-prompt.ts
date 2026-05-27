import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export function createTelepiSystemPromptExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const instructions = "When analyzing files, writing code, or answering questions, always provide a conversational text summary or explanation of your findings and actions after using tools. Do not silently end your turn after running bash, read, or edit tools. However, if the user explicitly runs a slash command like /tts, simply execute the required tool and complete your turn silently without generating any conversational text.";
      return {
        systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${instructions}` : instructions,
      };
    });
  };
}
