import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { istDateKey, isTradingDayIST } from "@neelkanth/core";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import { UnauthorizedError, ValidationError } from "../errors.js";
import { OddsRefusal } from "../odds/refusal.js";
import {
  loadCandlesBefore,
  setupOddsFromStore,
  storedCoverage,
} from "../odds/store.js";
import { buildCheckpointOdds } from "../odds/checkpoint-odds.js";
import type { CheckpointOddsTable } from "@neelkanth/core";

/** History the three-part target's odds are built from (PLAN.md 14.17). */
const CHECKPOINT_DAYS = 180;
const CHECKPOINT_INDICES = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"];
import {
  loadTradingCalendar,
  type TradingCalendar,
} from "../scanner/calendar.js";
import { fetchSymbolFiles, scanFromStore } from "../scanner/store.js";
import type { ApiServer } from "../server.js";

export interface ResearchRoutesDeps {
  /** The research database — the only one this service ever holds. */
  db: Db;
  /** The shared secret a caller must present as a bearer token. */
  token: string;
  now: () => number;
  /**
   * The broker's public symbol files, for the scan's universe. Fetched from
   * the broker when omitted; injected for tests.
   */
  symbolFiles?: () => Promise<{ fo: string; cm: string }>;
  /** Defaults to the shared NSE calendar file. */
  calendar?: TradingCalendar;
}

/**
 * One plan, as the dashboard sends it (design §6.1 D12, D16). Bounded here,
 * at the boundary: a request cannot ask for a million replays, and an
 * unknown field is refused rather than ignored.
 */
const OddsBody = z
  .object({
    symbol: z.string().min(1),
    side: z.enum(["LONG", "SHORT"]),
    entry: z.number().positive(),
    stop: z.number().positive(),
    target: z.number().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "an IST date, YYYY-MM-DD"),
    time: z.string().regex(/^\d{2}:\d{2}$/, "an IST time, HH:MM"),
    rule: z
      .object({
        type: z.string().min(1),
        params: z.record(z.string(), z.unknown()).default({}),
      })
      .strict()
      .optional(),
    indexSymbols: z.array(z.string().min(1)).max(10).default([]),
    replays: z.number().int().min(100).max(50_000).default(10_000),
    seed: z.number().int().min(0).default(0),
    window: z.number().int().min(0).max(12).default(1),
    poolSessions: z.number().int().min(1).optional(),
    capital: z.number().positive().default(1_000_000),
    /** Keep the run beside the other experiments. Default: keep nothing. */
    save: z.boolean().default(false),
  })
  .strict();

/** A pre-open scan, as the dashboard asks for it (design §7.1 D8). */
const ScanBody = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "an IST date, YYYY-MM-DD"),
    minDaysToExpiry: z.number().int().min(0).max(30).default(2),
    /** Keep the run beside the other experiments. Default: keep nothing. */
    save: z.boolean().default(false),
  })
  .strict();

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ValidationError(
      result.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/**
 * The research service's HTTP surface (design §6.1 D16): setup odds over the
 * research database, for the trading API to relay to on the operator's behalf.
 *
 * It holds one database handle and no broker, no Redis and no trading
 * repository, so nothing reachable from here can place an order or change a
 * position. Every route but the health probes needs the shared secret.
 */
export function registerResearchRoutes(
  app: ApiServer,
  deps: ResearchRoutesDeps,
): void {
  const expected = digest(`Bearer ${deps.token}`);

  app.addHook("onRequest", (request, _reply, done) => {
    if (request.url.startsWith("/health/")) {
      done();
      return;
    }
    // Compared as digests, in constant time: neither the token's length nor
    // how much of it matched is told by how long the answer takes.
    const given = digest(request.headers.authorization ?? "");
    done(
      timingSafeEqual(given, expected)
        ? undefined
        : new UnauthorizedError("a valid bearer token is required"),
    );
  });

  /** What the store holds, so a plan can be made for a symbol and date it covers. */
  app.get("/odds/coverage", () => storedCoverage(deps.db, "5m"));

  // The three-part target's odds table (PLAN.md 14.17): built from the last
  // CHECKPOINT_DAYS of stored index bars, kept for the IST day it was built
  // on. The trading process fetches it at boot and each morning and decides
  // from memory; it never waits on this service mid-trade (D16).
  let checkpointCache: { day: string; table: CheckpointOddsTable } | null =
    null;
  app.get("/checkpoint-odds", async () => {
    const day = istDateKey(deps.now());
    if (checkpointCache?.day !== day) {
      const fromTs = deps.now() - CHECKPOINT_DAYS * 86_400_000;
      const bars = await loadCandlesBefore(
        deps.db,
        CHECKPOINT_INDICES,
        "5m",
        day,
        fromTs,
      );
      checkpointCache = { day, table: buildCheckpointOdds(bars, deps.now()) };
    }
    return checkpointCache.table;
  });

  app.post("/odds", async (request) => {
    const body = parse(OddsBody, request.body);
    const createdAt = deps.now();
    const experimentId = `odds_${String(createdAt)}`;
    try {
      const { run, saved } = await setupOddsFromStore(deps.db, {
        plan: {
          symbol: body.symbol,
          side: body.side,
          entry: body.entry,
          stop: body.stop,
          target: body.target,
          date: body.date,
          time: body.time,
        },
        indexSymbols: body.indexSymbols,
        interval: "5m",
        resampling: {
          replays: body.replays,
          seed: body.seed,
          window: body.window,
        },
        ...(body.poolSessions === undefined
          ? {}
          : { lookbackSessions: body.poolSessions }),
        ...(body.rule === undefined ? {} : { rule: body.rule }),
        hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
        allocatedCapital: body.capital,
        limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
        experimentId,
        createdAt,
        save: body.save,
      });
      return {
        experimentId: saved ? experimentId : null,
        saved,
        fingerprint: run.fingerprint,
        manifest: run.manifest,
        result: run.result,
      };
    } catch (error) {
      // A plan the odds cannot be computed for is the request's fault, and
      // its words are for the operator. Anything else is ours, and opaque.
      if (error instanceof OddsRefusal)
        throw new ValidationError(error.message);
      throw error;
    }
  });

  const calendar = deps.calendar ?? loadTradingCalendar();
  const symbolFiles = deps.symbolFiles ?? cachedSymbolFiles(deps.now);

  /** The daily bars the scan can judge on, per symbol. */
  app.get("/scan/coverage", () => storedCoverage(deps.db, "1d"));

  app.post("/scan", async (request) => {
    const body = parse(ScanBody, request.body);
    if (
      !isTradingDayIST(body.date, calendar.holidays, calendar.specialSessions)
    )
      throw new ValidationError(
        `${body.date} is not a trading day: a pre-open scan is for a day the exchange opens`,
      );
    const createdAt = deps.now();
    const experimentId = `scan_${String(createdAt)}`;
    const { run, manifest, saved } = await scanFromStore(deps.db, {
      scanDate: body.date,
      files: await symbolFiles(),
      minDaysToExpiry: body.minDaysToExpiry,
      holidays: calendar.holidays,
      specialSessions: calendar.specialSessions,
      experimentId,
      createdAt,
      save: body.save,
    });
    return {
      experimentId: saved ? experimentId : null,
      saved,
      fingerprint: run.fingerprint,
      manifest,
      result: run.result,
    };
  });
}

/**
 * The symbol files, fetched once per IST day. They are some 19 MB together
 * and the broker republishes them daily, so a second scan the same day reuses
 * the first one's copy rather than downloading them again.
 */
function cachedSymbolFiles(
  now: () => number,
): () => Promise<{ fo: string; cm: string }> {
  let cached: {
    day: string;
    files: Promise<{ fo: string; cm: string }>;
  } | null = null;
  return () => {
    const day = istDateKey(now());
    if (cached?.day !== day) {
      const files = fetchSymbolFiles();
      // A failed fetch is not kept: the next scan tries again.
      files.catch(() => {
        cached = null;
      });
      cached = { day, files };
    }
    return cached.files;
  };
}
