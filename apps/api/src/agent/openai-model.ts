import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ModelRequest, ModelTurn, ResearchModel } from "./model.js";

/** The providers that speak OpenAI's chat-completions format (D8). */
export type OpenAICompatibleProvider = "openai" | "deepseek" | "gemini";

/** Where each provider is reached; OpenAI's is the SDK's own default. */
export const PROVIDER_BASE_URL: Record<
  OpenAICompatibleProvider,
  string | undefined
> = {
  openai: undefined,
  deepseek: "https://api.deepseek.com",
  // Google's OpenAI-compatible endpoint for the Gemini API.
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionFunctionTool;

/** The loop's tools as functions — the same JSON schemas (D8). */
export function toChatTools(
  tools: readonly Anthropic.Beta.BetaTool[],
): ChatTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      parameters: t.input_schema,
    },
  }));
}

const textOf = (blocks: readonly { type: string }[]): string =>
  blocks
    .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");

/**
 * The loop's conversation as chat messages (D8): a user turn of text stays
 * one; a user turn of tool results becomes one `tool` message each, an error
 * marked as one; an assistant turn keeps its text and its tool calls, ids and
 * all. Thinking is not sent back.
 */
export function toChatMessages(
  system: string,
  messages: readonly Anthropic.Beta.BetaMessageParam[],
  extras: ReadonlyMap<string, unknown> = new Map(),
): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(
        m.role === "user"
          ? { role: "user", content: m.content }
          : { role: "assistant", content: m.content },
      );
      continue;
    }
    if (m.role === "user") {
      for (const b of m.content)
        if (b.type === "tool_result") {
          const body =
            typeof b.content === "string" ? b.content : textOf(b.content ?? []);
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: b.is_error === true ? `ERROR: ${body}` : body,
          });
        }
      const text = textOf(m.content);
      if (text !== "") out.push({ role: "user", content: text });
      continue;
    }
    if (m.role !== "assistant") continue; // the loop sends no other role
    const blocks: readonly { type: string }[] = m.content;
    const calls = blocks
      .filter(
        (b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use",
      )
      .map((b) => ({
        id: b.id,
        type: "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
        // What the provider attached to the call, back exactly as received —
        // Gemini's thought signature, without which it refuses the turn.
        ...(extras.has(b.id) ? { extra_content: extras.get(b.id) } : {}),
      }));
    const text = textOf(blocks);
    out.push({
      role: "assistant",
      content: text === "" ? null : text,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    });
  }
  return out;
}

const STOP: Record<string, Anthropic.Beta.BetaStopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

/** Arguments that do not parse reach the loop as input the tool rejects (D8). */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { unparseableArguments: raw };
  }
}

/**
 * What a provider attached to each tool call beyond OpenAI's fields
 * (`extra_content` — Gemini's `google.thought_signature`), by call id: opaque,
 * to be sent back unchanged with that call (D8).
 */
export function extrasOf(
  c: OpenAI.Chat.Completions.ChatCompletion,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const call of c.choices[0]?.message.tool_calls ?? []) {
    const extra = (call as { extra_content?: unknown }).extra_content;
    if (extra !== undefined) out.set(call.id, extra);
  }
  return out;
}

/** A chat completion as a loop turn (D8). */
export function fromCompletion(
  c: OpenAI.Chat.Completions.ChatCompletion,
): ModelTurn {
  const choice = c.choices[0];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const text = choice?.message.content ?? "";
  if (text !== "") content.push({ type: "text", text, citations: null });
  for (const call of choice?.message.tool_calls ?? [])
    if (call.type === "function")
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
  const finish = choice?.finish_reason ?? null;
  return {
    content,
    // A reply that calls tools is a tool turn, whatever its finish reason says.
    stopReason:
      finish === "length" || finish === "content_filter"
        ? (STOP[finish] ?? null)
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : finish === null
            ? null
            : (STOP[finish] ?? "end_turn"),
    servedBy: c.model,
    usage: {
      input: c.usage?.prompt_tokens ?? 0,
      output: c.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * OpenAI, or DeepSeek or Gemini through the same client at its own address
 * (D8). The model is the operator's to name — there is no default. One
 * instance serves one session: it keeps what the provider attached to each
 * call, to send it back.
 */
export class OpenAICompatibleModel implements ResearchModel {
  private readonly extras = new Map<string, unknown>();

  constructor(
    private readonly client: OpenAI,
    readonly id: string,
  ) {}

  static for(
    provider: OpenAICompatibleProvider,
    apiKey: string,
    model: string,
  ): OpenAICompatibleModel {
    const baseURL = PROVIDER_BASE_URL[provider];
    return new OpenAICompatibleModel(
      new OpenAI({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) }),
      model,
    );
  }

  async turn(request: ModelRequest): Promise<ModelTurn> {
    const completion = await this.client.chat.completions.create({
      model: this.id,
      messages: toChatMessages(request.system, request.messages, this.extras),
      tools: toChatTools(request.tools),
      tool_choice: "auto",
    });
    for (const [id, extra] of extrasOf(completion)) this.extras.set(id, extra);
    return fromCompletion(completion);
  }
}
