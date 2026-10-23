import Anthropic from "@anthropic-ai/sdk";

/** The model the operator chose at opening (design Q1). */
export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ModelRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

/** One model turn, as the loop needs it. */
export interface ModelTurn {
  /** Every block, to be sent back unchanged — thinking blocks included. */
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: Anthropic.Beta.BetaStopReason | null;
  /** The model that served the turn — another when a refusal fell back. */
  servedBy: string;
  usage: { input: number; output: number };
}

/** What the loop is written against (D6): a real model, or a scripted one. */
export interface ResearchModel {
  readonly id: string;
  turn(request: ModelRequest): Promise<ModelTurn>;
}

/**
 * Claude, through the Messages API (D6): adaptive thinking, effort `high`,
 * streamed, every tool strict with its input streamed eagerly (the loop
 * validates each input before it runs), server-side refusal fallbacks
 * routed by category ("default"), and the stable prefix — tools and system —
 * cached.
 */
export class AnthropicResearchModel implements ResearchModel {
  constructor(
    private readonly client: Anthropic = new Anthropic(),
    readonly id: string = DEFAULT_MODEL,
    private readonly effort: "medium" | "high" | "xhigh" = "high",
  ) {}

  async turn(request: ModelRequest): Promise<ModelTurn> {
    let unparseable = 0;
    for (;;) {
      const stream = this.client.beta.messages.stream({
        model: this.id,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort },
        cache_control: { type: "ephemeral" },
        system: request.system,
        messages: request.messages,
        tools: request.tools.map((t) => ({
          ...t,
          eager_input_streaming: true,
        })),
      });
      try {
        const m = await stream.finalMessage();
        return {
          content: m.content,
          stopReason: m.stop_reason,
          servedBy: m.model,
          usage: {
            input:
              m.usage.input_tokens +
              (m.usage.cache_read_input_tokens ?? 0) +
              (m.usage.cache_creation_input_tokens ?? 0),
            output: m.usage.output_tokens,
          },
        };
      } catch (e) {
        // A tool input streamed eagerly that could not be parsed at all: the
        // turn is re-issued, twice at most. API errors are the caller's.
        if (e instanceof Anthropic.APIError || unparseable++ >= 2) throw e;
      }
    }
  }
}

/** A planned turn of a scripted session. */
export type ScriptedStep =
  | { tools: { name: string; input: unknown }[]; text?: string }
  | { text: string }
  | { refusal: true }
  | { truncated: true };

/**
 * A model that plays a script (D6): each turn is the next step, whatever the
 * request — and every request is kept, so a test can read what the loop sent
 * back. No network, no key.
 */
export class ScriptedModel implements ResearchModel {
  readonly id = "scripted";
  readonly requests: ModelRequest[] = [];
  private next = 0;

  constructor(private readonly steps: readonly ScriptedStep[]) {}

  turn(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(request));
    const step = this.steps[this.next];
    const n = this.next;
    this.next += 1;
    const turn = (
      content: Anthropic.Beta.BetaContentBlock[],
      stopReason: Anthropic.Beta.BetaStopReason,
    ): Promise<ModelTurn> =>
      Promise.resolve({
        content,
        stopReason,
        servedBy: this.id,
        usage: { input: 0, output: 0 },
      });
    const text = (t: string) =>
      ({
        type: "text",
        text: t,
        citations: null,
      }) as Anthropic.Beta.BetaTextBlock;
    if (step === undefined)
      return turn([text("(the script has ended)")], "end_turn");
    if ("refusal" in step) return turn([], "refusal");
    if ("truncated" in step) return turn([text("…")], "max_tokens");
    if (!("tools" in step)) return turn([text(step.text)], "end_turn");
    return turn(
      [
        ...(step.text === undefined ? [] : [text(step.text)]),
        ...step.tools.map((t, i): Anthropic.Beta.BetaToolUseBlock => ({
          type: "tool_use",
          id: `toolu_${String(n)}_${String(i)}`,
          name: t.name,
          input: t.input,
        })),
      ],
      "tool_use",
    );
  }
}
