import { PatternRegistry } from "./registry.js";
import { orbBreakout } from "./orb-breakout.js";
import { emaCross } from "./ema-cross.js";
import { rsiReversion } from "./rsi-reversion.js";
import { vwapReclaim } from "./vwap-reclaim.js";
import { volumeBreakout } from "./volume-breakout.js";

export * from "./contract.js";
export * from "./registry.js";
export * from "./shared.js";
export * from "./orb-breakout.js";
export * from "./ema-cross.js";
export * from "./rsi-reversion.js";
export * from "./vwap-reclaim.js";
export * from "./volume-breakout.js";

/**
 * The first five detectors (Phase 5).
 *
 * Chosen to span the structures the existing strategies react to, so the
 * matrix has something to correlate against from its first run: a
 * session-anchored break, a trend cross, a reversion from an extreme, a
 * fair-value reclaim, and a volume-confirmed break.
 */
export const BUILTIN_DETECTORS = [
  orbBreakout,
  emaCross,
  rsiReversion,
  vwapReclaim,
  volumeBreakout,
] as const;

export function registerBuiltinDetectors(registry: PatternRegistry): void {
  registry.register(orbBreakout);
  registry.register(emaCross);
  registry.register(rsiReversion);
  registry.register(vwapReclaim);
  registry.register(volumeBreakout);
}

/** A registry pre-loaded with the built-in detectors. */
export function createPatternRegistry(): PatternRegistry {
  const registry = new PatternRegistry();
  registerBuiltinDetectors(registry);
  return registry;
}
