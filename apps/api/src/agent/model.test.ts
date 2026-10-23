import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { SUBMIT_ANSWER_TOOL } from "./answer.js";
import { AnthropicResearchModel, DEFAULT_MODEL } from "./model.js";

/** Task 11.3 (design D6): the request the Anthropic model sends — pinned, with no network. */
const message = (model = DEFAULT_MODEL) => ({
  model,
  content: [{ type: "text", text: "ok", citations: null }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 0,
  },
});

/** A client whose stream returns the given outcomes in turn, recording each request. */
function stub(outcomes: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          sent.push(params);
          const next = outcomes.shift();
          return {
            finalMessage: () =>
              next instanceof Error
                ? Promise.reject(next)
                : Promise.resolve(next),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

const REQUEST = {
  system: "s",
  messages: [{ role: "user" as const, content: "q" }],
  tools: [SUBMIT_ANSWER_TOOL],
};

describe("the Anthropic model (11.3, D6, Q1)", () => {
  it("asks Claude Opus 5.5 with adaptive thinking, effort high, fallbacks, caching and strict eager tools", async () => {
    const { client, sent } = stub([message()]);
    const turn = await new AnthropicResearchModel(client).turn(REQUEST);
    expect(sent[0]).toMatchObject({
      model: "claude-opus-5-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      system: "s",
      messages: REQUEST.messages,
    });
    expect(sent[0]?.["tools"]).toEqual([
      { ...SUBMIT_ANSWER_TOOL, strict: true, eager_input_streaming: true },
    ]);
    expect(turn).toMatchObject({
      stopReason: "end_turn",
      servedBy: "claude-opus-5-5",
      usage: { input: 100, output: 5 },
    });
  });

  it("reports the model that served a fallen-back turn", async () => {
    const { client } = stub([message("claude-opus-5")]);
    expect(
      (await new AnthropicResearchModel(client).turn(REQUEST)).servedBy,
    ).toBe("claude-opus-5");
  });

  it("re-issues a turn whose tool input could not be parsed — twice at most", async () => {
    const { client, sent } = stub([new SyntaxError("bad json"), message()]);
    await new AnthropicResearchModel(client).turn(REQUEST);
    expect(sent).toHaveLength(2);
    const always = stub([
      new SyntaxError("1"),
      new SyntaxError("2"),
      new SyntaxError("3"),
      message(),
    ]);
    await expect(
      new AnthropicResearchModel(always.client).turn(REQUEST),
    ).rejects.toThrow("3");
    expect(always.sent).toHaveLength(3);
  });

  it("never retries an API error — it is the caller's", async () => {
    const error = new Anthropic.APIError(
      429,
      undefined,
      "rate limited",
      undefined,
    );
    const { client, sent } = stub([error, message()]);
    await expect(new AnthropicResearchModel(client).turn(REQUEST)).rejects.toBe(
      error,
    );
    expect(sent).toHaveLength(1);
  });
});
