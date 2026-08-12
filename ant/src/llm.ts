/**
 * llm.ts — the act-step LLM port, via pi-ai (@mariozechner/pi-ai).
 *
 * Boundary discipline (the v0 lesson): coordination lives in deterministic
 * code — the DCU loop, folds, claims, evidence shapes. The LLM is only ever
 * invoked *inside* a worker's act step to produce content. It cannot choose
 * what to listen to, when to claim, or what shape evidence must take.
 *
 * Inference goes through DeepSeek's OpenAI-compatible endpoint by default:
 *   DEEPSEEK_API_KEY   required (never committed)
 *   ANT_LLM_MODEL      default deepseek-v4-flash
 *   ANT_LLM_BASE_URL   default https://api.deepseek.com
 */

import { complete, type Context, type Model } from "@mariozechner/pi-ai";

const MODEL_ID = process.env.ANT_LLM_MODEL ?? "deepseek-v4-flash";
const BASE_URL = process.env.ANT_LLM_BASE_URL ?? "https://api.deepseek.com";

const model: Model<"openai-completions"> = {
  id: MODEL_ID,
  name: `${MODEL_ID} (ant act step)`,
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: BASE_URL,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4000,
};

export interface LlmUsage {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

/** Cumulative usage for this process — the MVP driver reports it at the end. */
export const usage: LlmUsage = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 };

export function requireApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error("ANT_WORKER=llm requires DEEPSEEK_API_KEY in the environment");
  }
  return key;
}

/** One text completion. Throws on transport errors after a single retry. */
export async function llmText(systemPrompt: string, user: string): Promise<string> {
  const apiKey = requireApiKey();
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: user, timestamp: Date.now() }],
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      usage.calls++;
      const msg = await complete(model, context, { apiKey });
      usage.inputTokens += msg.usage?.input ?? 0;
      usage.outputTokens += msg.usage?.output ?? 0;
      if (msg.stopReason === "error") throw new Error(`llm stopReason=error`);
      const text = msg.content
        .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text.trim().length === 0) throw new Error("llm returned empty text");
      return text;
    } catch (err) {
      lastErr = err;
      usage.errors++;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Ask for a JSON object and parse it leniently (first '{' … last '}').
 * The caller — deterministic code — still owns the evidence shape: it reads
 * only the fields it wants and supplies fallbacks for anything missing.
 */
export async function llmJson(systemPrompt: string, user: string): Promise<Record<string, unknown>> {
  const text = await llmText(systemPrompt, `${user}\n\n只输出一个 JSON 对象，不要任何其他文字。`);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`llm did not return JSON: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

/** Coerce helpers — the deterministic side of the LLM boundary. */
export const asString = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;

export const asStringArray = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;
