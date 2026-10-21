import { describe, expect, it } from "vitest";
import { canonicalJson } from "./strategy-version.js";
import {
  definitionKey,
  PatternOccurrenceSchema,
  patternParamsKey,
  toObservation,
  type PatternOccurrence,
} from "./pattern.js";
import { CandleSchema } from "./market.js";
import { marketContextOf, provenanceOf } from "./trade.js";

/**
 * A params key is the strategy version's and the replay fingerprint's
 * serialisation (Phase 5 audit §2.2 point 2). Two copies can drift — and a
 * drifted key would split one parameter set into two samples, or merge two.
 */
describe("patternParamsKey", () => {
  it("is canonicalJson of the parameters", () => {
    const params = { slow: 21, fast: 9, nested: { b: 2, a: [3, 1] } };
    expect(patternParamsKey(params)).toBe(canonicalJson(params));
    expect(patternParamsKey(params)).toBe(
      '{"fast":9,"nested":{"a":[3,1],"b":2},"slow":21}',
    );
  });

  it("does not depend on the order the parameters were written in", () => {
    expect(patternParamsKey({ fast: 9, slow: 21 })).toBe(
      patternParamsKey({ slow: 21, fast: 9 }),
    );
    expect(patternParamsKey({ fast: 9, slow: undefined })).toBe(
      patternParamsKey({ fast: 9 }),
    );
  });

  it("refuses a key too long for the identity index", () => {
    expect(() =>
      patternParamsKey({
        levels: Array.from({ length: 200 }, (_, i) => i * 1000),
      }),
    ).toThrow(/too long/);
  });
});

const OCCURRENCE: PatternOccurrence = {
  patternId: "EMA_CROSS",
  detectorVersion: "1.0.0",
  symbol: "NSE:X-EQ",
  interval: "5m",
  ts: 1_000,
  direction: "BULLISH",
  evidence: { fast: 101 },
  params: { slow: 21, fast: 9 },
  dataProvenance: {
    symbol: "NSE:X-EQ",
    interval: "5m",
    barTs: 1_000,
    source: "BROKER_HISTORICAL",
    ingestionVersion: 1,
  },
  marketContext: { volumeAvailable: true, volumeQuality: "SUSPECT" },
};

describe("toObservation", () => {
  it("adds the params key and when it was observed", () => {
    const observation = toObservation(OCCURRENCE, 2_000);
    expect(observation).toMatchObject({
      paramsKey: '{"fast":9,"slow":21}',
      observedAt: 2_000,
    });
  });
});

/**
 * PLAN.md §10 / design D4: every observation carries its market context and
 * its data provenance — the Trade's Phase 2 shapes, so a pattern and a trade
 * on one bar describe it the same way.
 */
describe("an observation says what it stood on (D4)", () => {
  it("keeps the provenance and market context through to the stored form", () => {
    const observation = toObservation(OCCURRENCE, 2_000);
    expect(observation.dataProvenance).toEqual(OCCURRENCE.dataProvenance);
    expect(observation.marketContext).toEqual(OCCURRENCE.marketContext);
  });

  it("refuses an occurrence without either", () => {
    const noProvenance: Record<string, unknown> = { ...OCCURRENCE };
    delete noProvenance["dataProvenance"];
    const noContext: Record<string, unknown> = { ...OCCURRENCE };
    delete noContext["marketContext"];
    expect(PatternOccurrenceSchema.safeParse(noProvenance).success).toBe(false);
    expect(PatternOccurrenceSchema.safeParse(noContext).success).toBe(false);
  });

  /** Provenance names a bar; it must be this occurrence's bar. */
  it("refuses provenance that names a different bar", () => {
    const elsewhere = (over: Record<string, unknown>) =>
      PatternOccurrenceSchema.safeParse({
        ...OCCURRENCE,
        dataProvenance: { ...OCCURRENCE.dataProvenance, ...over },
      }).success;
    expect(elsewhere({})).toBe(true);
    expect(elsewhere({ barTs: 1_300 })).toBe(false);
    expect(elsewhere({ symbol: "NSE:Y-EQ" })).toBe(false);
    expect(elsewhere({ interval: "1m" })).toBe(false);
    expect(() => toObservation({ ...OCCURRENCE, ts: 1_300 }, 2_000)).toThrow();
  });
});

describe("provenanceOf / marketContextOf — one reading of a bar", () => {
  const candle = (fields: Record<string, unknown> = {}) =>
    CandleSchema.parse({
      symbol: "NSE:X-EQ",
      interval: "5m",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
      ts: 9_000,
      ...fields,
    });

  it("snapshots the bar's key, source and ingestion version", () => {
    expect(
      provenanceOf(
        candle({ source: "BROKER_HISTORICAL", ingestionVersion: 2 }),
      ),
    ).toEqual({
      symbol: "NSE:X-EQ",
      interval: "5m",
      barTs: 9_000,
      source: "BROKER_HISTORICAL",
      ingestionVersion: 2,
    });
    expect(provenanceOf(candle())).not.toHaveProperty("ingestionVersion");
  });

  /** Copied, never defaulted: a silent bar keeps the candle's own meaning. */
  it("copies the volume flags exactly, and invents none", () => {
    expect(marketContextOf(candle())).toEqual({});
    expect(marketContextOf(candle({ volumeQuality: "SUSPECT" }))).toEqual({
      volumeQuality: "SUSPECT",
    });
    expect(
      marketContextOf(
        candle({ volumeAvailable: false, volumeQuality: "UNAVAILABLE" }),
      ),
    ).toEqual({
      volumeAvailable: false,
      volumeQuality: "UNAVAILABLE",
    });
  });
});

describe("definitionKey (D5)", () => {
  const def = {
    patternId: "EMA_CROSS",
    detectorVersion: "1.0.0",
    definition: "fast crosses slow",
    defaultParams: { fast: 9, slow: 21 },
    volumeBased: false,
  };
  it("is the rule — text, defaults, volume use — and not the identity", () => {
    expect(definitionKey(def)).toBe(
      definitionKey({ ...def, defaultParams: { slow: 21, fast: 9 } }),
    );
    expect(definitionKey(def)).not.toBe(
      definitionKey({ ...def, defaultParams: { fast: 10, slow: 21 } }),
    );
    expect(definitionKey(def)).not.toBe(
      definitionKey({ ...def, definition: "fast crosses slow, twice" }),
    );
    expect(definitionKey(def)).not.toBe(
      definitionKey({ ...def, volumeBased: true }),
    );
  });
});
