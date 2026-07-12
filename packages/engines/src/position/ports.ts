import type { PnlSnapshot, Position } from "@neelkanth/core";
import type { PublishFn } from "../market-data/ports.js";

/**
 * Infrastructure the Position Engine writes through (plan/05 §3). The
 * composition root implements these with redis (hot position state) + db
 * (`positions`); tests pass fakes. The Position Engine is the sole writer of
 * position state (plan/02 §8, plan/13 §3).
 */
export interface PositionPorts {
  /** Upsert the position by positionId — hot copy + durable `positions` row. */
  writePosition(position: Position): Promise<void>;
  publish: PublishFn;
}

/** Infrastructure the PnL Engine writes through (plan/13 §5-6). */
export interface PnlPorts {
  /** Latest price for a symbol (`hot:price`), or null when the feed has none. */
  readPrice(symbol: string): Promise<number | null>;
  /** Append an EOD snapshot to `pnl_snapshots` (plan/07, plan/13 §6). */
  writeSnapshot(snapshot: PnlSnapshot): Promise<void>;
  publish: PublishFn;
}
