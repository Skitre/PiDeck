import {
  completeSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

const DEFAULT_SESSION_TITLE = "新会话";
const MAX_SESSION_TITLE_LENGTH = 28;

type TitleModelRegistry = {
  getApiKeyAndHeaders: (model: Model<Api>) => Promise<
    | {
        ok: true;
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
      }
    | { ok: false; error: string }
  >;
};

type CompleteTitle = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

function truncateTitle(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_SESSION_TITLE_LENGTH) return value;
  return `${chars.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join("")}…`;
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:session\s+title|title|会话标题|标题)\s*[:：-]\s*/i, "")
    .replace(/^[#>*_`'"“”‘’]+|[#>*_`'"“”‘’]+$/g, "")
    .replace(/[。.!?！？;；:：]+$/u, "")
    .trim();
}

export function sanitizeSessionTitle(
  value: string,
  fallback = DEFAULT_SESSION_TITLE,
): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => cleanTitle(line))
    .find(Boolean);
  return truncateTitle(firstLine || fallback);
}

export function createProvisionalSessionTitle(prompt: string): string {
  const firstSentence = prompt.split(/[\r\n。！？!?]/u).find((part) => part.trim());
  return sanitizeSessionTitle(firstSentence ?? prompt);
}

export function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      content?: unknown;
    };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) continue;
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          ),
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export async function generateRefinedSessionTitle(args: {
  model: Model<Api>;
  modelRegistry: TitleModelRegistry;
  userPrompt: string;
  assistantText: string;
  complete?: CompleteTitle;
}): Promise<string> {
  const auth = await args.modelRegistry.getApiKeyAndHeaders(args.model);
  if (!auth.ok) throw new Error(auth.error);

  const context: Context = {
    systemPrompt: [
      "Create a concise title for this coding-agent conversation.",
      "Use the same language as the user.",
      "Use 4-10 words or 8-20 CJK characters.",
      "Do not use quotes, markdown, labels, or ending punctuation.",
      "Return only the title.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          `User request:\n${args.userPrompt.slice(0, 2_000)}`,
          args.assistantText
            ? `Assistant response:\n${args.assistantText.slice(0, 2_000)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        timestamp: Date.now(),
      },
    ],
  };
  const response = await (args.complete ?? completeSimple)(args.model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: 64,
    reasoning: "minimal",
    timeoutMs: 15_000,
    maxRetries: 0,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Title generation ${response.stopReason}`);
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return sanitizeSessionTitle(text, createProvisionalSessionTitle(args.userPrompt));
}
