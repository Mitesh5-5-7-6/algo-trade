import type { Db } from "mongodb";
import { CANDLE_SOURCE_RANK, CandleSchema, type Candle } from "@neelkanth/core";
import { COLLECTIONS } from "@neelkanth/db";

/**
 * Test-only: seed an EMPTY candles collection in one round trip.
 *
 * The documents are exactly what `CandlesRepository.upsert` writes into an
 * empty collection — the parsed bar and its denormalised `sourceRank` — so a
 * suite reads them back as it would after one upsert per bar. One upsert per
 * bar was 1,500 round trips per seed against the remote scratch cluster, in
 * every test's setup; the research suites' share of the sign-off's
 * intermittent ECONNRESETs (design limit L7) came from that.
 */
export async function seedCandles(
  db: Db,
  bars: readonly Candle[],
): Promise<void> {
  if (bars.length === 0) return;
  const docs = bars.map((bar) => {
    const doc = CandleSchema.parse(bar);
    return { ...doc, sourceRank: CANDLE_SOURCE_RANK[doc.source] };
  });
  await db.collection(COLLECTIONS.candles).insertMany(docs, { ordered: true });
}
