import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import type { PatternObservation } from "../research/observations.js";
import type { DailyReport } from "../research/report.js";
import { SUBMIT_ANSWER_TOOL } from "./answer.js";
import { runResearch } from "./loop.js";
import {
  fromCompletion,
  OpenAICompatibleModel,
  PROVIDER_BASE_URL,
  toChatMessages,
  toChatTools,
} from "./openai-model.js";
import { ToolContext } from "./tools.js";

/** Task 11.6 (design D8): one adapter for OpenAI and DeepSeek — translated both ways, no network. */
type Completion = OpenAI.Chat.Completions.ChatCompletion;
const completion = (
  message: {
    content?: string | null;
    tool_calls?: { id: string; name: string; arguments: string }[];
  },
  finish: string,
  model = "gpt-test",
): Completion =>
  ({
    id: "x",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        finish_reason: finish,
        logprobs: null,
        message: {
          role: "assistant",
          refusal: null,
          content: message.content ?? null,
          ...(message.tool_calls === undefined
            ? {}
            : {
                tool_calls: message.tool_calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }),
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  }) as unknown as Completion;

describe("the loop's conversation as chat messages (11.6, D8)", () => {
  it("translates tools to functions with their schemas unchanged", () => {
    expect(toChatTools([SUBMIT_ANSWER_TOOL])).toEqual([
      {
        type: "function",
        function: {
          name: "submit_answer",
          description: SUBMIT_ANSWER_TOOL.description,
          parameters: SUBMIT_ANSWER_TOOL.input_schema,
        },
      },
    ]);
  });

  it("keeps the question, each call with its id, each result — an error marked — and drops thinking", () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: "As of 2026-03-31: how often?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…", signature: "s" },
          { type: "text", text: "Looking." },
          {
            type: "tool_use",
            id: "call_1",
            name: "find_patterns",
            input: { patterns: ["ORB_BREAKOUT"] },
          },
          { type: "tool_use", id: "call_2", name: "place_order", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            is_error: false,
            content: '{"call":"c1"}',
          },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            is_error: true,
            content: "there is no tool place_order",
          },
        ],
      },
      { role: "user", content: "Finish by calling submit_answer." },
    ];
    expect(toChatMessages("SYS", messages)).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "As of 2026-03-31: how often?" },
      {
        role: "assistant",
        content: "Looking.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "find_patterns",
              arguments: '{"patterns":["ORB_BREAKOUT"]}',
            },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "place_order", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"call":"c1"}' },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: "ERROR: there is no tool place_order",
      },
      { role: "user", content: "Finish by calling submit_answer." },
    ]);
  });

  it("an assistant turn of tool calls alone has no text", () => {
    const [, a] = toChatMessages("S", [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c", name: "t", input: {} }],
      },
    ]);
    expect(a).toMatchObject({ role: "assistant", content: null });
  });
});

describe("a chat completion as a loop turn (11.6, D8)", () => {
  it("turns tool calls into tool_use blocks, ids kept, arguments parsed", () => {
    const t = fromCompletion(
      completion(
        {
          content: "Checking.",
          tool_calls: [
            {
              id: "call_9",
              name: "trade_history",
              arguments: '{"strategies":["ORB"]}',
            },
          ],
        },
        "tool_calls",
        "deepseek-x",
      ),
    );
    expect(t).toEqual({
      content: [
        { type: "text", text: "Checking.", citations: null },
        {
          type: "tool_use",
          id: "call_9",
          name: "trade_history",
          input: { strategies: ["ORB"] },
        },
      ],
      stopReason: "tool_use",
      servedBy: "deepseek-x",
      usage: { input: 120, output: 30 },
    });
  });

  it("unparseable arguments reach the loop as input a tool rejects — never run", () => {
    const t = fromCompletion(
      completion(
        {
          tool_calls: [
            { id: "c", name: "find_patterns", arguments: '{"patterns": [' },
          ],
        },
        "tool_calls",
      ),
    );
    expect(t.content[0]).toMatchObject({
      type: "tool_use",
      input: { unparseableArguments: '{"patterns": [' },
    });
  });

  it("maps the finish reasons the loop acts on", () => {
    expect(
      fromCompletion(completion({ content: "done" }, "stop")).stopReason,
    ).toBe("end_turn");
    expect(
      fromCompletion(completion({ content: "…" }, "length")).stopReason,
    ).toBe("max_tokens");
    expect(
      fromCompletion(completion({ content: "" }, "content_filter")).stopReason,
    ).toBe("refusal");
    // A cut-off reply is cut off even if it started a tool call.
    expect(
      fromCompletion(
        completion(
          { tool_calls: [{ id: "c", name: "t", arguments: "{" }] },
          "length",
        ),
      ).stopReason,
    ).toBe("max_tokens");
    // Some providers finish "stop" while calling tools: it is a tool turn.
    expect(
      fromCompletion(
        completion(
          { tool_calls: [{ id: "c", name: "t", arguments: "{}" }] },
          "stop",
        ),
      ).stopReason,
    ).toBe("tool_use");
  });
});

/** A client whose completions are scripted, every request recorded. */
function stubClient(replies: Completion[]) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create(params: Record<string, unknown>) {
          sent.push(structuredClone(params));
          const next = replies.shift();
          return next === undefined
            ? Promise.reject(new Error("script ended"))
            : Promise.resolve(next);
        },
      },
    },
  } as unknown as OpenAI;
  return { client, sent };
}

const occurrence = (ts: number): PatternObservation => ({
  patternId: "ORB_BREAKOUT",
  detectorVersion: "1.0.0",
  ts,
  direction: "BULLISH",
  evidence: {},
  marketContext: {},
  regime: "BULLISH",
  strategies: {},
});
class Fixed extends ToolContext {
  constructor() {
    super({} as Db, "2026-03-31");
  }
  override dailyReports(): Promise<DailyReport[]> {
    return Promise.resolve([
      {
        date: "2026-03-02",
        symbol: "NSE:X-INDEX",
        dailyResearchVersion: "1",
        features: {
          sources: { BROKER_HISTORICAL: 75 },
          ingestionVersions: [1],
        },
        models: {},
        strategies: [],
        trades: [],
        patterns: [occurrence(1), occurrence(2), occurrence(3), occurrence(4)],
      } as unknown as DailyReport,
    ]);
  }
}

describe("the adapter in the loop (11.6, D8)", () => {
  it("sends the model, the messages, the functions and tool_choice auto", async () => {
    const { client, sent } = stubClient([
      completion({ content: "hi" }, "stop"),
    ]);
    await new OpenAICompatibleModel(client, "gpt-test").turn({
      system: "S",
      messages: [{ role: "user", content: "q" }],
      tools: [SUBMIT_ANSWER_TOOL],
    });
    expect(sent[0]).toEqual({
      model: "gpt-test",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "q" },
      ],
      tools: toChatTools([SUBMIT_ANSWER_TOOL]),
      tool_choice: "auto",
    });
  });

  it("answers a research question end to end, checked like any other model's", async () => {
    const { client, sent } = stubClient([
      completion(
        {
          tool_calls: [
            { id: "call_a", name: "find_patterns", arguments: "{}" },
          ],
        },
        "tool_calls",
      ),
      completion(
        {
          tool_calls: [
            {
              id: "call_b",
              name: "submit_answer",
              arguments: JSON.stringify({
                summary: "It fired.",
                claims: [
                  {
                    statement: "ORB_BREAKOUT fired n = 4 times on 2026-03-02.",
                    cites: ["c1"],
                  },
                ],
                caveats: [],
              }),
            },
          ],
        },
        "tool_calls",
      ),
    ]);
    const s = await runResearch(
      "How often?",
      new Fixed(),
      new OpenAICompatibleModel(client, "gpt-test"),
    );
    expect(s).toMatchObject({
      status: "ANSWERED",
      verdict: "SUPPORTED",
      model: "gpt-test",
      servedBy: ["gpt-test"],
      usage: { input: 240, output: 60 },
    });
    // The second request carried the first call and its result, ids paired.
    const second = sent[1]?.["messages"] as {
      role: string;
      tool_call_id?: string;
    }[];
    expect(second.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(second[3]?.tool_call_id).toBe("call_a");
  });

  it("a number not in the evidence is UNSUPPORTED whichever provider wrote it", async () => {
    const bad = JSON.stringify({
      summary: "x",
      claims: [{ statement: "It fired 40 times.", cites: ["c1"] }],
      caveats: [],
    });
    const { client } = stubClient([
      completion(
        { tool_calls: [{ id: "a", name: "find_patterns", arguments: "{}" }] },
        "tool_calls",
      ),
      completion(
        { tool_calls: [{ id: "b", name: "submit_answer", arguments: bad }] },
        "tool_calls",
      ),
    ]);
    const s = await runResearch(
      "How often?",
      new Fixed(),
      new OpenAICompatibleModel(client, "m"),
      { maxCorrections: 0 },
    );
    expect(s).toMatchObject({ status: "ANSWERED", verdict: "UNSUPPORTED" });
  });

  it("reaches DeepSeek at its own address, OpenAI at the SDK's", () => {
    expect(PROVIDER_BASE_URL).toEqual({
      openai: undefined,
      deepseek: "https://api.deepseek.com",
    });
    const deepseek = OpenAICompatibleModel.for(
      "deepseek",
      "k",
      "m",
    ) as unknown as { client: OpenAI };
    expect(deepseek.client.baseURL).toBe("https://api.deepseek.com");
    const openai = OpenAICompatibleModel.for("openai", "k", "m") as unknown as {
      client: OpenAI;
    };
    expect(openai.client.baseURL).toBe("https://api.openai.com/v1");
  });
});
