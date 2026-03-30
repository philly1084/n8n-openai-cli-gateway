import type { ChatMessage } from "../types";

export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const headerParts = [message.role.toUpperCase()];
      if (message.name) {
        headerParts.push(`name=${message.name}`);
      }
      if (message.tool_call_id) {
        headerParts.push(`tool_call_id=${message.tool_call_id}`);
      }
      return `${headerParts.join(" ")}:\n${message.content}`.trim();
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

export function extractTextContentOrJson(content: unknown): string {
  const text = extractTextContent(content);
  if (text.trim()) {
    return text;
  }

  if (content === null || content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
