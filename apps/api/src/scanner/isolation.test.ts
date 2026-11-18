import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 18.6, its second half (design §7.1 D2): candidates, never signals.
 * Proved on the source itself, both ways — the scanner reaches no trading
 * state, and nothing that trades reaches the scanner or what it keeps.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));
const SCANNER = fileURLToPath(new URL(".", import.meta.url));

const TRADING_REPOSITORIES =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

/** Every non-test TypeScript file under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Where the scanner may be used: itself, and the research service. */
const ALLOWED = [`scanner${sep}`, `research-api${sep}`];
const allowed = (path: string): boolean =>
  ALLOWED.some((prefix) => relative(SRC, path).startsWith(prefix));

describe("the scanner cannot reach an order (18.6, D2)", () => {
  it("imports no trading repository or collection", () => {
    const files = sources(SCANNER);
    expect(files.length).toBeGreaterThan(3); // the scan saw real files
    const offenders = files.filter((f) =>
      TRADING_REPOSITORIES.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("is imported by nothing but the research service", () => {
    const files = sources(SRC).filter((f) => !allowed(f));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((f) => /from\s+"[^"]*\/scanner\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("keeps runs no trading code reads: nothing else names a SCAN record", () => {
    const offenders = sources(SRC)
      .filter((f) => !allowed(f))
      .filter((f) => /kind:\s*"SCAN"|"SCAN"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
