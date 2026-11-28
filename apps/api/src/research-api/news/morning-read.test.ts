import { describe, expect, it, vi } from "vitest";
import type { NewsItem } from "@neelkanth/core";
import {
  extractJson,
  headlinesPrompt,
  MAX_HEADLINES,
  previousWeekday,
  readWindowStart,
  redactSecrets,
  runMorningRead,
  selectHeadlines,
  validateRead,
  type ChatFn,
} from "./morning-read.js";

const item = (newsId: string, over: Partial<NewsItem> = {}): NewsItem => ({
  newsId,
  source: "economictimes",
  feed: "et-markets",
  url: `https://x.example/${newsId}`,
  title: `headline ${newsId}`,
  publishedAt: 1_000,
  ingestedAt: 1_000,
  symbols: [],
  topics: [],
  ...over,
});

const AI = {
  provider: "gemini" as const,
  model: "gemini-test",
  apiKey: "AIzaSECRETKEY1234567890",
};

describe("the read window", () => {
  it("starts at the previous weekday's close, 15:30 IST", () => {
    expect(previousWeekday("2026-11-30")).toBe("2026-11-27"); // Mon -> Fri
    expect(previousWeekday("2026-12-01")).toBe("2026-11-30");
    expect(new Date(readWindowStart("2026-11-30")).toISOString()).toBe(
      "2026-11-27T10:00:00.000Z", // Friday 15:30 IST
    );
  });
});

describe("selectHeadlines", () => {
  it("puts heavyweight and topic matches first, newest first, one copy of a title, at most the cap", () => {
    const items = [
      item("plain-new", { publishedAt: 900 }),
      item("sbi-old", { publishedAt: 100, symbols: ["NSE:SBIN-EQ"] }),
      item("rbi-mid", { publishedAt: 500, topics: ["RBI"] }),
      item("plain-old", { publishedAt: 50 }),
      item("dup", {
        publishedAt: 400,
        title: "Headline RBI-MID!",
        topics: ["RBI"],
      }),
      item("rbi-copy", { publishedAt: 300, title: "headline rbi mid" }),
    ];
    expect(selectHeadlines(items).map((i) => i.newsId)).toEqual([
      "rbi-mid",
      "sbi-old",
      "plain-new",
      "plain-old",
    ]);
    expect(selectHeadlines(items, 2).map((i) => i.newsId)).toEqual([
      "rbi-mid",
      "sbi-old",
    ]);
    const many = Array.from({ length: 300 }, (_, i) =>
      item(`n${String(i)}`, { publishedAt: i }),
    );
    expect(selectHeadlines(many)).toHaveLength(MAX_HEADLINES);
  });
});

describe("extractJson", () => {
  it("parses the whole answer, or the first JSON object inside it", () => {
    expect(extractJson('{"flags":[],"stockTone":[]}')).toEqual({
      flags: [],
      stockTone: [],
    });
    expect(
      extractJson(
        'Here you go:\n```json\n{"flags": [{"detail": "a } in a string"}], "stockTone": []}\n```',
      ),
    ).toEqual({ flags: [{ detail: "a } in a string" }], stockTone: [] });
    expect(extractJson('{not json} then {"ok": true}')).toEqual({ ok: true });
    expect(extractJson("no object here")).toBeNull();
  });
});

describe("validateRead — every claim must cite what was sent", () => {
  const sent = new Set(["a1", "b2"]);
  const flag = (over: Record<string, unknown> = {}) => ({
    kind: "MAJOR_NEGATIVE",
    detail: "Bank stocks fall on asset quality worries",
    symbols: ["NSE:SBIN-EQ"],
    tone: -1,
    headlineIds: ["a1"],
    ...over,
  });

  it("keeps what is valid and drops — with a note each — what cites an unknown id or names a non-heavyweight", () => {
    const out = validateRead(
      {
        flags: [
          flag(),
          flag({ kind: "GLOBAL_RISK_OFF", headlineIds: ["a1", "zz9"] }),
          flag({ kind: "MAJOR_POSITIVE", symbols: ["NSE:ZOMATO-EQ"], tone: 1 }),
          flag({ kind: "NOT_A_KIND" }),
          flag({ detail: "x".repeat(301) }),
          flag({ headlineIds: [] }),
        ],
        stockTone: [
          { symbol: "NSE:SBIN-EQ", tone: -1, headlineIds: ["a1"] },
          { symbol: "NSE:PAYTM-EQ", tone: 1, headlineIds: ["b2"] },
          { symbol: "NSE:INFY-EQ", tone: 1, headlineIds: ["made-up"] },
          { symbol: "NSE:SBIN-EQ", tone: 1, headlineIds: ["b2"] },
          { symbol: "NSE:TCS-EQ", tone: 2, headlineIds: ["b2"] },
        ],
      },
      sent,
    );
    expect(out.flags).toEqual([flag()]);
    expect(out.stockTone).toEqual([
      { symbol: "NSE:SBIN-EQ", tone: -1, headlineIds: ["a1"] },
    ]);
    expect(out.notes).toEqual([
      'dropped flag GLOBAL_RISK_OFF: cites headline id "zz9" not in the set sent',
      "dropped flag MAJOR_POSITIVE: names NSE:ZOMATO-EQ, not a heavyweight",
      expect.stringMatching(/^dropped flag #4: invalid \(kind: /),
      expect.stringMatching(/^dropped flag #5: invalid \(detail: /),
      expect.stringMatching(/^dropped flag #6: invalid \(headlineIds: /),
      "dropped stockTone NSE:PAYTM-EQ: not a heavyweight",
      'dropped stockTone NSE:INFY-EQ: cites headline id "made-up" not in the set sent',
      "dropped stockTone NSE:SBIN-EQ: given twice, the first kept",
      expect.stringMatching(/^dropped stockTone #5: invalid \(tone: /),
    ]);
  });

  it("drops everything, with a note, when the answer is not the asked shape", () => {
    expect(validateRead({ flags: "none" }, sent)).toEqual({
      flags: [],
      stockTone: [],
      notes: [
        expect.stringMatching(
          /^the model's answer was not \{flags, stockTone\}/,
        ),
      ],
    });
    expect(validateRead({}, sent)).toEqual({
      flags: [],
      stockTone: [],
      notes: [],
    });
  });
});

describe("runMorningRead — one model call, no network here", () => {
  const items = [
    item("a1", {
      title: "SBI shares fall 4% on bad loans",
      symbols: ["NSE:SBIN-EQ"],
      publishedAt: 2_000,
    }),
    item("b2", {
      title: "Nasdaq jumps 2% overnight",
      topics: ["US_MARKETS"],
      publishedAt: 1_500,
    }),
  ];

  it("sends each headline with its id, keeps the checked answer and notes the drops", async () => {
    const chat = vi.fn<ChatFn>(() =>
      Promise.resolve({
        model: "gemini-test-served",
        text: JSON.stringify({
          flags: [
            {
              kind: "GLOBAL_RISK_ON",
              detail: "US tech rallied overnight",
              symbols: [],
              tone: 1,
              headlineIds: ["b2"],
            },
            {
              kind: "MAJOR_NEGATIVE",
              detail: "invented",
              symbols: [],
              tone: -1,
              headlineIds: ["c3"],
            },
          ],
          stockTone: [{ symbol: "NSE:SBIN-EQ", tone: -1, headlineIds: ["a1"] }],
        }),
      }),
    );
    const read = await runMorningRead({
      date: "2026-11-30",
      now: 9_000,
      items,
      ai: AI,
      aiNote: null,
      chat,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const sent = chat.mock.calls[0]?.[0];
    expect(sent?.user).toContain("a1 | ");
    expect(sent?.user).toContain(
      "| economictimes | SBI shares fall 4% on bad loans",
    );
    expect(sent?.user).toContain("NSE:SBIN-EQ = State Bank of India");
    expect(sent?.system).toMatch(/only ids from the list/);
    expect(read).toEqual({
      date: "2026-11-30",
      at: 9_000,
      flags: [
        {
          kind: "GLOBAL_RISK_ON",
          detail: "US tech rallied overnight",
          symbols: [],
          tone: 1,
          headlineIds: ["b2"],
        },
      ],
      stockTone: [{ symbol: "NSE:SBIN-EQ", tone: -1, headlineIds: ["a1"] }],
      headlinesRead: 2,
      headlineIds: ["a1", "b2"],
      ai: { provider: "gemini", model: "gemini-test-served", at: 9_000 },
      notes: [
        'dropped flag MAJOR_NEGATIVE: cites headline id "c3" not in the set sent',
      ],
    });
  });

  it("skips the call without a key, and says why", async () => {
    const chat = vi.fn<ChatFn>();
    const read = await runMorningRead({
      date: "2026-11-30",
      now: 9_000,
      items,
      ai: null,
      aiNote: "no AI key configured",
      chat,
    });
    expect(chat).not.toHaveBeenCalled();
    expect(read).toMatchObject({
      flags: [],
      headlinesRead: 0,
      ai: null,
      notes: ["no AI key configured"],
    });
  });

  it("skips the call when there are no headlines", async () => {
    const chat = vi.fn<ChatFn>();
    const read = await runMorningRead({
      date: "2026-11-30",
      now: 1,
      items: [],
      ai: AI,
      aiNote: null,
      chat,
    });
    expect(chat).not.toHaveBeenCalled();
    expect(read.notes).toEqual([
      "no headlines in the window; nothing was read",
    ]);
  });

  it("turns a failed call into a note, with the key redacted", async () => {
    const chat: ChatFn = () =>
      Promise.reject(
        new Error(
          `401 API key not valid: ${AI.apiKey}; also sk-proj-abcdef123456`,
        ),
      );
    const read = await runMorningRead({
      date: "2026-11-30",
      now: 1,
      items,
      ai: AI,
      aiNote: null,
      chat,
    });
    expect(read.ai).toBeNull();
    expect(read.notes).toEqual([
      "the AI read failed (gemini): 401 API key not valid: <redacted>; also <redacted>",
    ]);
    expect(JSON.stringify(read)).not.toContain("SECRET");
  });

  it("notes an answer with no JSON in it", async () => {
    const chat: ChatFn = () =>
      Promise.resolve({ text: "I cannot help with that.", model: "m" });
    const read = await runMorningRead({
      date: "2026-11-30",
      now: 1,
      items,
      ai: AI,
      aiNote: null,
      chat,
    });
    expect(read).toMatchObject({
      flags: [],
      stockTone: [],
      headlinesRead: 2,
      notes: ["the model's answer held no JSON object"],
    });
    expect(read.ai).toEqual({ provider: "gemini", model: "m", at: 1 });
  });
});

describe("headlinesPrompt and redactSecrets", () => {
  it("writes one line per headline, in IST", () => {
    const text = headlinesPrompt("2026-11-30", [
      item("a1", {
        publishedAt: Date.parse("2026-11-30T02:30:00Z"),
        title: "T",
      }),
    ]);
    expect(text).toContain("a1 | 11-30 08:00 | economictimes | T");
  });

  it("removes the key and key-shaped strings", () => {
    expect(redactSecrets("key=abc123xyz here", "abc123xyz")).toBe(
      "key=<redacted> here",
    );
    expect(redactSecrets("AIzaSyA1234567890abcdef")).toBe("<redacted>");
  });
});
