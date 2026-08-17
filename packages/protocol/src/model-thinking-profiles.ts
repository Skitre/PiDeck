import type { ThinkingLevel, ThinkingLevelMap } from "./types.js";

export type ModelThinkingProfile = {
  family: string;
  modelIdPattern: RegExp;
  thinkingLevelMap: ThinkingLevelMap;
  documentationUrl: string;
};

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function exactThinkingLevelMap(
  supported: Partial<Record<ThinkingLevel, string>>,
): ThinkingLevelMap {
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, supported[level] ?? null]),
  ) as ThinkingLevelMap;
}

const OPENAI_MODEL_DOCS = "https://developers.openai.com/api/docs/models";
const OPENAI_LATEST_MODEL_DOCS = "https://developers.openai.com/api/docs/guides/latest-model";
const ANTHROPIC_THINKING_DOCS =
  "https://platform.claude.com/docs/en/build-with-claude/extended-thinking";
const ANTHROPIC_ADAPTIVE_DOCS =
  "https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking";
const ANTHROPIC_EFFORT_DOCS = "https://platform.claude.com/docs/en/build-with-claude/effort";
const GEMINI_THINKING_DOCS = "https://ai.google.dev/gemini-api/docs/thinking";
const XAI_REASONING_DOCS = "https://docs.x.ai/developers/model-capabilities/text/reasoning";
const ZAI_CHAT_DOCS = "https://docs.z.ai/api-reference/llm/chat-completion";
const DEEPSEEK_THINKING_DOCS = "https://api-docs.deepseek.com/guides/thinking_mode";
const QWEN_THINKING_DOCS = "https://help.aliyun.com/en/model-studio/deep-thinking";
const KIMI_CHAT_DOCS = "https://platform.kimi.ai/docs/api/chat";
const MISTRAL_REASONING_DOCS = "https://docs.mistral.ai/studio-api/conversations/reasoning";

/**
 * Fallback capability catalog for models whose Provider does not advertise
 * reasoning efforts. A null entry means the PiDeck level is unavailable.
 * Keep specific variants before broader family patterns.
 */
export const MODEL_THINKING_PROFILES: readonly ModelThinkingProfile[] = [
  {
    family: "GPT-5.6",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]6(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    }),
    documentationUrl: OPENAI_LATEST_MODEL_DOCS,
  },
  {
    family: "GPT-5.5 Pro",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]5[-_.]pro(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.5-pro`,
  },
  {
    family: "GPT-5.5",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]5(?=$|:|[-_.]\d{4}[-_.]\d{2}[-_.]\d{2}$)/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.5`,
  },
  {
    family: "GPT-5.4 Pro",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]4[-_.]pro(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.4-pro`,
  },
  {
    family: "GPT-5.4",
    modelIdPattern:
      /(?:^|[/.:])gpt[-_.]?5[.-]4(?:[-_.](?:mini|nano))?(?=$|:|[-_.]\d{4}[-_.]\d{2}[-_.]\d{2}$)/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.4`,
  },
  {
    family: "GPT-5.3 Codex",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]3[-_.]codex(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.3-codex`,
  },
  {
    family: "GPT-5.2 Pro",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]2[-_.]pro(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.2-pro`,
  },
  {
    family: "GPT-5.2",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]2(?=$|:|[-_.]\d{4}[-_.]\d{2}[-_.]\d{2}$)/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.2`,
  },
  {
    family: "GPT-5.1",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[.-]1(?=$|:|[-_.]\d{4}[-_.]\d{2}[-_.]\d{2}$)/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5.1`,
  },
  {
    family: "GPT-5 Pro",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5[-_.]pro(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({ high: "high" }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5-pro`,
  },
  {
    family: "GPT-5",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?5(?=$|:|[-_.]\d{4}[-_.]\d{2}[-_.]\d{2}$)/,
    thinkingLevelMap: exactThinkingLevelMap({
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-5`,
  },
  {
    family: "GPT OSS",
    modelIdPattern: /(?:^|[/.:])gpt[-_.]?oss[-_.]?(?:20b|120b)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: `${OPENAI_MODEL_DOCS}/gpt-oss-120b`,
  },
  {
    family: "Claude adaptive thinking",
    modelIdPattern:
      /(?:^|[/.:])claude[-_.]?(?:(?:fable|mythos|opus|sonnet)[-_.]?5|opus[-_.]4[-_.](?:7|8))(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    }),
    documentationUrl: ANTHROPIC_EFFORT_DOCS,
  },
  {
    family: "Claude adaptive thinking (no xhigh)",
    modelIdPattern:
      /(?:^|[/.:])claude[-_.]?(?:mythos[-_.]?preview|(?:opus|sonnet)[-_.]4[-_.]6)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    }),
    documentationUrl: ANTHROPIC_ADAPTIVE_DOCS,
  },
  {
    family: "Claude manual thinking",
    modelIdPattern:
      /(?:^|[/.:])claude[-_.]?(?:3[-_.]7[-_.]sonnet|(?:opus|sonnet)[-_.]4(?:(?:[-_.](?:1|5))|(?![-_.]\d))|haiku[-_.]4[-_.]5)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: ANTHROPIC_THINKING_DOCS,
  },
  {
    family: "Gemini 3.7 Flash",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?3[.-]7[-_.]flash(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 3.1 Flash-Lite Image",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?3[.-]1[-_.]flash[-_.]lite[-_.]image(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      minimal: "minimal",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 3.1 Flash Image",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?3[.-]1[-_.]flash[-_.]image(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      minimal: "minimal",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 3.1 Pro",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?3[.-]1[-_.]pro(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 3 Pro Image",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?3[-_.]pro[-_.]image(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({ high: "high" }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 3 Pro",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?3[-_.]pro(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 3 Flash",
    modelIdPattern:
      /(?:^|[/.:])gemini[-_.]?(?:3[-_.]flash|3[.-]1[-_.]flash[-_.]lite|3[.-]5[-_.](?:flash|flash[-_.]lite)|3[.-]6[-_.]flash)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemini 2.5",
    modelIdPattern: /(?:^|[/.:])gemini[-_.]?2[.-]5[-_.](?:pro|flash)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Gemma 4",
    modelIdPattern: /(?:^|[/.:])gemma[-_.]?4(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      minimal: "minimal",
      high: "high",
    }),
    documentationUrl: GEMINI_THINKING_DOCS,
  },
  {
    family: "Grok 4.6",
    modelIdPattern: /(?:^|[/.:])grok[-_.]?4[.-]6(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    }),
    documentationUrl: XAI_REASONING_DOCS,
  },
  {
    family: "Grok 4.5",
    modelIdPattern: /(?:^|[/.:])grok[-_.]?4[.-]5(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: XAI_REASONING_DOCS,
  },
  {
    family: "Grok 4.3",
    modelIdPattern: /(?:^|[/.:])grok[-_.]?4[.-]3(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
    }),
    documentationUrl: XAI_REASONING_DOCS,
  },
  {
    family: "GLM-5.3",
    modelIdPattern: /(?:^|[/.:])glm[-_.]?5[.-]3(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      high: "high",
      max: "max",
    }),
    documentationUrl: ZAI_CHAT_DOCS,
  },
  {
    family: "GLM-5.2",
    modelIdPattern: /(?:^|[/.:])glm[-_.]?5[.-]2(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      high: "high",
      max: "max",
    }),
    documentationUrl: ZAI_CHAT_DOCS,
  },
  {
    family: "GLM hybrid thinking",
    modelIdPattern:
      /(?:^|[/.:])glm[-_.]?(?:4[.-](?:5|6|7)|5(?![.-](?:2|3)(?:$|[-_.:]))(?:[.-]1|[-_.]?turbo|v[-_.]?turbo)?)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      high: "high",
    }),
    documentationUrl: ZAI_CHAT_DOCS,
  },
  {
    family: "DeepSeek V4",
    modelIdPattern: /(?:^|[/.:])deepseek[-_.]?v4[-_.](?:flash|pro)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      low: "low",
      high: "high",
      max: "max",
    }),
    documentationUrl: DEEPSEEK_THINKING_DOCS,
  },
  {
    family: "DeepSeek R1",
    modelIdPattern: /(?:^|[/.:])deepseek[-_.]?(?:r1|reasoner)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({ high: "high" }),
    documentationUrl: DEEPSEEK_THINKING_DOCS,
  },
  {
    family: "Qwen thinking-only",
    modelIdPattern: /(?:^|[/.:])qwen[^/]*(?:[-_.]thinking)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({ high: "high" }),
    documentationUrl: QWEN_THINKING_DOCS,
  },
  {
    family: "QwQ",
    modelIdPattern: /(?:^|[/.:])qwq(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({ high: "high" }),
    documentationUrl: QWEN_THINKING_DOCS,
  },
  {
    family: "Qwen hybrid thinking",
    modelIdPattern:
      /(?:^|[/.:])qwen[-_.]?(?:3[.-](?:5|6|7|8)[-_.](?:plus|flash|max)|3[.-]8|3[-_.]max(?![-_.]thinking(?:$|[-_.:]))|3[-_.](?:235b[-_.]a22b|32b|30b[-_.]a3b|14b|8b)(?=$|:)|plus|max|flash|turbo)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      high: "high",
    }),
    documentationUrl: QWEN_THINKING_DOCS,
  },
  {
    family: "Kimi K3",
    modelIdPattern: /(?:^|[/.:])kimi[-_.]?k3(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      low: "low",
      high: "high",
      max: "max",
    }),
    documentationUrl: KIMI_CHAT_DOCS,
  },
  {
    family: "Kimi thinking-only",
    modelIdPattern: /(?:^|[/.:])kimi[-_.]?(?:k2[-_.]thinking|k2[.-]7[-_.]code)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({ high: "high" }),
    documentationUrl: KIMI_CHAT_DOCS,
  },
  {
    family: "Kimi hybrid thinking",
    modelIdPattern: /(?:^|[/.:])kimi[-_.]?k2[.-](?:5|6)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      high: "high",
    }),
    documentationUrl: KIMI_CHAT_DOCS,
  },
  {
    family: "Mistral adjustable reasoning",
    modelIdPattern: /(?:^|[/.:])mistral[-_.]?(?:small[-_.]latest|medium[-_.]3[-_.]5)(?:$|[-_.:])/,
    thinkingLevelMap: exactThinkingLevelMap({
      off: "none",
      high: "high",
    }),
    documentationUrl: MISTRAL_REASONING_DOCS,
  },
];

export function findModelThinkingProfile(modelId: string): ModelThinkingProfile | undefined {
  const normalizedId = modelId.trim().toLowerCase();
  return MODEL_THINKING_PROFILES.find((profile) => profile.modelIdPattern.test(normalizedId));
}
