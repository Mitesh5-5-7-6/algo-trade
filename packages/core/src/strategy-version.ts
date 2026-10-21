import type { StrategyConfig } from "./strategy.js";

/**
 * The version a strategy's decisions are stamped with (§2.8, PLAN.md rule 9:
 * "Every strategy is versioned").
 *
 * `strategyVersion` reaches Signal, Order and Trade, but no route sets it on a
 * config, so without this every decision went out unversioned. A version an
 * operator DECLARED wins. Otherwise one is derived from what decides — the
 * type, the params, the risk rules and the exit rules — and labelled `cfg-` so it can never be
 * mistaken for a declared one.
 *
 * What is left out is the point. A rename is not a different strategy (the
 * reason the field is not derived from `updatedAt`), and neither is a symbol
 * added to the list: each instance decides one symbol by the same rule
 * regardless of its siblings. Identical rules get identical versions, so
 * research comparing versions sees change only where decisions could change.
 *
 * Exact-code identity — which build of the strategy ran — is a separate,
 * later `strategyRevision` (design §5.4 Q4). This identifies the config.
 */
export function strategyVersionOf(
  config: Pick<
    StrategyConfig,
    "type" | "params" | "riskRules" | "exitRules"
  > & {
    strategyVersion?: string | undefined;
  },
): string {
  if (config.strategyVersion !== undefined) return config.strategyVersion;
  const rule = canonicalJson({
    type: config.type,
    params: config.params,
    riskRules: config.riskRules,
    exitRules: config.exitRules,
  });
  return `cfg-${cyrb53(rule).toString(16).padStart(14, "0")}`;
}

/**
 * JSON with object keys sorted and `undefined` dropped, so the same value
 * always serialises the same way however it was written. Shared by the
 * strategy version and a replay's fingerprint (Phase 4 D5).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * cyrb53: a small, deterministic 53-bit string hash.
 *
 * Not cryptographic, and it need not be: it tells a handful of configs apart,
 * where 53 bits make an accidental collision negligible. Pure JS rather than
 * `node:crypto` because `core` is also bundled for the dashboard.
 */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
