import { z } from "zod";
import { TickSchema } from "@neelkanth/core";
import type { TickNormalizer } from "@neelkanth/engines";

// FYERS WebSocket V3 data format for L2/L1 quotes.
const FyersRawTickSchema = z
  .object({
    symbol: z.string().min(1),
    ltp: z.number(),
    vol_traded_today: z.number().optional(),
    v: z.number().optional(),
    bid: z.number().optional(),
    ask: z.number().optional(),
    exch_feed_time: z.number().optional(),
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

  const tsSeconds = r.exch_feed_time ?? r.tt ?? Math.floor(Date.now() / 1000);

  const tick = {
    symbol: r.symbol,
    ltp: r.ltp,
    volume: deltaVol,
    ...(r.bid !== undefined ? { bid: r.bid } : {}),
    ...(r.ask !== undefined ? { ask: r.ask } : {}),
    ts: tsSeconds > 1e11 ? tsSeconds : tsSeconds * 1000,
  };

  const validated = TickSchema.safeParse(tick);
  return validated.success ? validated.data : null;
};
