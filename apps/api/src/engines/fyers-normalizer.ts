import { z } from "zod";
import { TickSchema } from "@neelkanth/core";
import type { TickNormalizer } from "@neelkanth/engines";

/**
 * The tick as the FYERS SDK emits it. Field names are the SDK's own mapped
 * output (`HSM/mapper.js`): `ltp`, `vol_traded_today`, `exch_feed_time`,
 * `bid_price`/`ask_price`. The short raw-protocol aliases (`v`, `bp`, `sp`,
 * `tt`) are accepted too, because lite mode and the depth tick carry different
 * subsets and the broker has changed these before.
 */
const FyersRawTickSchema = z
  .object({
    symbol: z.string().min(1),
    ltp: z.number(),
    vol_traded_today: z.number().optional(),
    v: z.number().optional(),
    bid_price: z.number().optional(),
    ask_price: z.number().optional(),
    bp: z.number().optional(),
    sp: z.number().optional(),
    bid: z.number().optional(),
    ask: z.number().optional(),
    exch_feed_time: z.number().optional(),
    last_traded_time: z.number().optional(),
    tt: z.number().optional(),
  })
  .passthrough();

const previousVolume = new Map<string, number>();

export const fyersNormalizer: TickNormalizer = (raw) => {
  let payload = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (Buffer.isBuffer(raw)) {
    try {
      payload = JSON.parse(raw.toString("utf-8"));
    } catch {
      return null;
    }
  }

  const parsed = FyersRawTickSchema.safeParse(payload);
  if (!parsed.success) return null;
  const r = parsed.data;

  const currentTotalVol = r.vol_traded_today ?? r.v ?? 0;
  const prevTotalVol = previousVolume.get(r.symbol) ?? currentTotalVol;
  const deltaVol = Math.max(0, currentTotalVol - prevTotalVol);
  previousVolume.set(r.symbol, currentTotalVol);

  const tsSeconds =
    r.exch_feed_time ??
    r.last_traded_time ??
    r.tt ??
    Math.floor(Date.now() / 1000);

  const bid = r.bid_price ?? r.bp ?? r.bid;
  const ask = r.ask_price ?? r.sp ?? r.ask;

  const tick = {
    symbol: r.symbol,
    ltp: r.ltp,
    volume: deltaVol,
    ...(bid !== undefined ? { bid } : {}),
    ...(ask !== undefined ? { ask } : {}),
    ts: tsSeconds > 1e11 ? tsSeconds : tsSeconds * 1000,
  };

  const validated = TickSchema.safeParse(tick);
  return validated.success ? validated.data : null;
};
