import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export function createTelepiSystemPromptExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const instructions = "Always provide a conversational text summary or response to the user after you finish using tools. Never end your turn without speaking to the user.";
      return {
        systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${instructions}` : instructions,
      };
    });
  };
}
