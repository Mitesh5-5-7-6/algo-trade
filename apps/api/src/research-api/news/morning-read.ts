import OpenAI from "openai";
import { z } from "zod";
import {
  DayFlagSchema,
  istDayStart,
  StockToneSchema,
  type DayFlag,
  type NewsItem,
  type StockTone,
} from "@neelkanth/core";
import type { MorningRead } from "@neelkanth/db";
import { PROVIDER_BASE_URL } from "../../agent/openai-model.js";
import type { ResearchAiConfig } from "../environment.js";
import { HEAVYWEIGHTS, HEAVYWEIGHT_SYMBOLS } from "./symbols.js";

/** The most headlines one read is shown. */
export const MAX_HEADLINES = 120;
const MINUTE = 60_000;

/** The weekday before an IST date (Friday for a Monday). */
export function previousWeekday(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  do day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/** The read covers news since the previous weekday's close, 15:30 IST. */
export function readWindowStart(date: string): number {
  return istDayStart(previousWeekday(date)) + (15 * 60 + 30) * MINUTE;
}

const normalise = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * What the model is shown: one copy of each title, headlines that name a
 * heavyweight or a topic first, then the rest, newest first within each;
 * at most `cap`.
 */
export function selectHeadlines(
  items: readonly NewsItem[],
  cap = MAX_HEADLINES,
): NewsItem[] {
  const seen = new Set<string>();
  const unique: NewsItem[] = [];
  for (const item of [...items].sort((a, b) => b.publishedAt - a.publishedAt)) {
    const key = normalise(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const matched = (n: NewsItem) => n.symbols.length > 0 || n.topics.length > 0;
  return [
    ...unique.filter(matched),
    ...unique.filter((n) => !matched(n)),
  ].slice(0, cap);
}

const istClock = (ms: number): string =>
  new Date(ms + 330 * MINUTE).toISOString().slice(5, 16).replace("T", " ");

export const SYSTEM_PROMPT = [
  "You read Indian market headlines before the open for an operator who buys NIFTY and BANKNIFTY index options.",
  "You are given headlines, each with an id. Answer with ONE JSON object and nothing else, of this shape:",
  '{"flags": [{"kind": K, "detail": string, "symbols": [symbol], "tone": -1|0|1, "headlineIds": [id]}], "stockTone": [{"symbol": symbol, "tone": -1|0|1, "headlineIds": [id]}]}',
  "kind is one of RBI_POLICY, UNION_BUDGET, FOMC, RESULTS, GLOBAL_RISK_OFF, GLOBAL_RISK_ON, MAJOR_NEGATIVE, MAJOR_POSITIVE, OTHER_EVENT.",
  "A flag is something that matters for the Indian index today; tone is for the market: -1 bad, 0 mixed or unclear, 1 good.",
  "RBI_POLICY, UNION_BUDGET and FOMC mean the scheduled decision itself (an RBI MPC rate decision, the Union Budget presentation, a US FOMC rate decision) falling today or overnight; other RBI circulars, auctions or Fed speeches are OTHER_EVENT. RESULTS means a heavyweight reports its quarterly results today.",
  "detail is one plain sentence of at most 300 characters.",
  "stockTone gives the news tone on a heavyweight stock, only when its headlines say something; omit stocks without news.",
  "Every flag and every stockTone must cite at least one headline id from the list, and only ids from the list.",
  "symbols may only be the heavyweight symbols listed. Do not invent facts that the headlines do not state.",
  'If nothing matters, answer {"flags": [], "stockTone": []}.',
].join("\n");

/** The user turn: the heavyweights and the headlines, one per line. */
export function headlinesPrompt(
  date: string,
  headlines: readonly NewsItem[],
): string {
  return [
    `Session date (IST): ${date}`,
    "",
    "Heavyweight symbols:",
    ...HEAVYWEIGHTS.map((h) => `${h.symbol} = ${h.name}`),
    "",
    "Headlines (id | IST time | source | title):",
    ...headlines.map(
      (h) =>
        `${h.newsId} | ${istClock(h.publishedAt)} | ${h.source} | ${h.title}`,
    ),
  ].join("\n");
}

/**
 * The first JSON object in a model's answer: the whole text when it parses,
 * else the first balanced `{...}` in it (a fenced block, a sentence around
 * it). Null when there is none.
 */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to a search for an object inside the text
  }
  for (
    let start = text.indexOf("{");
    start !== -1;
    start = text.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as unknown;
          } catch {
            break; // not JSON from this brace; try the next one
          }
        }
      }
    }
  }
  return null;
}

const AnswerSchema = z.object({
  flags: z.array(z.unknown()).default([]),
  stockTone: z.array(z.unknown()).default([]),
});

const issues = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ");

/**
 * The model's answer, checked. A flag or a tone is DROPPED — never repaired —
 * when it does not validate, cites a headline id that was not sent, or names
 * a symbol outside the heavyweight list; each drop is noted.
 */
export function validateRead(
  answer: unknown,
  sentIds: ReadonlySet<string>,
  symbols: ReadonlySet<string> = HEAVYWEIGHT_SYMBOLS,
): { flags: DayFlag[]; stockTone: StockTone[]; notes: string[] } {
  const notes: string[] = [];
  const parsed = AnswerSchema.safeParse(answer);
  if (!parsed.success) {
    notes.push(
      `the model's answer was not {flags, stockTone}: ${issues(parsed.error)}`,
    );
    return { flags: [], stockTone: [], notes };
  }
  const citesUnknown = (ids: readonly string[]) =>
    ids.filter((id) => !sentIds.has(id));
  const flags: DayFlag[] = [];
  parsed.data.flags.forEach((raw, i) => {
    const flag = DayFlagSchema.safeParse(raw);
    if (!flag.success) {
      notes.push(
        `dropped flag #${String(i + 1)}: invalid (${issues(flag.error)})`,
      );
      return;
    }
    const f = flag.data;
    const unknownIds = citesUnknown(f.headlineIds);
    const outside = f.symbols.filter((s) => !symbols.has(s));
    if (unknownIds.length > 0)
      notes.push(
        `dropped flag ${f.kind}: cites headline id ${unknownIds.map((id) => `"${id}"`).join(", ")} not in the set sent`,
      );
    else if (outside.length > 0)
      notes.push(
        `dropped flag ${f.kind}: names ${outside.join(", ")}, not a heavyweight`,
      );
    else flags.push(f);
  });
  const stockTone: StockTone[] = [];
  const toned = new Set<string>();
  parsed.data.stockTone.forEach((raw, i) => {
    const tone = StockToneSchema.safeParse(raw);
    if (!tone.success) {
      notes.push(
        `dropped stockTone #${String(i + 1)}: invalid (${issues(tone.error)})`,
      );
      return;
    }
    const t = tone.data;
    const unknownIds = citesUnknown(t.headlineIds);
    if (!symbols.has(t.symbol))
      notes.push(`dropped stockTone ${t.symbol}: not a heavyweight`);
    else if (unknownIds.length > 0)
      notes.push(
        `dropped stockTone ${t.symbol}: cites headline id ${unknownIds.map((id) => `"${id}"`).join(", ")} not in the set sent`,
      );
    else if (toned.has(t.symbol))
      notes.push(`dropped stockTone ${t.symbol}: given twice, the first kept`);
    else {
      toned.add(t.symbol);
      stockTone.push(t);
    }
  });
  return { flags, stockTone, notes };
}

/** One chat completion's text. */
export type ChatFn = (messages: { system: string; user: string }) => Promise<{
  text: string;
  model: string;
}>;

/** Keys and key-shaped strings out of a message before it is logged or kept. */
export function redactSecrets(message: string, secret?: string): string {
  let out = message;
  if (secret !== undefined && secret.length >= 6)
    out = out.split(secret).join("<redacted>");
  return out
    .replace(/sk-[A-Za-z0-9_*-]{6,}/g, "<redacted>")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "<redacted>");
}

/**
 * The provider's chat endpoint, OpenAI-compatible (`PROVIDER_BASE_URL`, the
 * research agent's own table): temperature 0, JSON mode asked for. Google's
 * documentation of its OpenAI-compatible endpoint shows structured output
 * only through the SDK's schema helpers and says nothing of
 * `response_format: {type: "json_object"}`; tried on 2026-11-28 with
 * gemini-3.5-flash-lite, it was accepted and the answer was bare JSON. Still,
 * a 400 answer to it is retried once without it, and the text is parsed for
 * the first JSON object either way. One retry on a network error at most —
 * no storm.
 */
export function openAiCompatibleChat(ai: ResearchAiConfig): ChatFn {
  const baseURL = PROVIDER_BASE_URL[ai.provider];
  const client = new OpenAI({
    apiKey: ai.apiKey,
    ...(baseURL === undefined ? {} : { baseURL }),
    timeout: 90_000,
    maxRetries: 1,
  });
  return async ({ system, user }) => {
    const base = {
      model: ai.model,
      temperature: 0,
      messages: [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ],
    };
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await client.chat.completions.create({
        ...base,
        response_format: { type: "json_object" },
      });
    } catch (error) {
      if (!(error instanceof OpenAI.BadRequestError)) throw error;
      completion = await client.chat.completions.create(base);
    }
    return {
      text: completion.choices[0]?.message.content ?? "",
      model: completion.model || ai.model,
    };
  };
}

export interface MorningReadInput {
  date: string;
  now: number;
  /** Headlines published in the window, any order. */
  items: readonly NewsItem[];
  /** Null when the read may not run; `aiNote` says why. */
  ai: ResearchAiConfig | null;
  aiNote: string | null;
  /** Injected for tests; built from `ai` when omitted. */
  chat?: ChatFn;
}

/**
 * The morning read of the headlines: one model call, its answer checked
 * against the headlines it was shown. Never throws — a failed call is a read
 * with no flags and a note.
 */
export async function runMorningRead(
  input: MorningReadInput,
): Promise<MorningRead> {
  const headlines = selectHeadlines(input.items);
  const headlineIds = headlines.map((h) => h.newsId);
  const empty: MorningRead = {
    date: input.date,
    at: input.now,
    flags: [],
    stockTone: [],
    headlinesRead: 0,
    headlineIds: [],
    ai: null,
    notes: [],
  };
  if (input.ai === null)
    return { ...empty, notes: [input.aiNote ?? "no AI key configured"] };
  if (headlines.length === 0)
    return {
      ...empty,
      notes: ["no headlines in the window; nothing was read"],
    };
  const chat = input.chat ?? openAiCompatibleChat(input.ai);
  let answer: { text: string; model: string };
  try {
    answer = await chat({
      system: SYSTEM_PROMPT,
      user: headlinesPrompt(input.date, headlines),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      headlineIds,
      notes: [
        `the AI read failed (${input.ai.provider}): ${redactSecrets(message, input.ai.apiKey)}`,
      ],
    };
  }
  const json = extractJson(answer.text);
  const checked =
    json === null
      ? {
          flags: [],
          stockTone: [],
          notes: ["the model's answer held no JSON object"],
        }
      : validateRead(json, new Set(headlineIds));
  return {
    date: input.date,
    at: input.now,
    flags: checked.flags,
    stockTone: checked.stockTone,
    headlinesRead: headlines.length,
    headlineIds,
    ai: { provider: input.ai.provider, model: answer.model, at: input.now },
    notes: checked.notes,
  };
}
