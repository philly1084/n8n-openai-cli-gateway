import type { ChatMessage } from "../types";

export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      return `${role}:\n${message.content}`.trim();
    })
    .join("\n\n");
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object") {
          const maybeText = (item as Record<string, unknown>).text;
          if (typeof maybeText === "string") {
            return maybeText;
          }

          const maybeInputText = (item as Record<string, unknown>).input_text;
          if (typeof maybeInputText === "string") {
            return maybeInputText;
          }
        }

        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (content && typeof content === "object") {
    const textField = (content as Record<string, unknown>).text;
    if (typeof textField === "string") {
      return textField;
    }
  }

  return "";
}
