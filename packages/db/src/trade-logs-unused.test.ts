import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 2.3 — `trade_logs` stays unused.
 *
 * It is declared right beside `trades` with a similar name and a 90-day TTL.
 * Completed trades are research evidence, and evidence on an operational TTL
 * is a dataset that shrinks under whoever is studying it (ADR §10.4). The
 * integration suite proves `trades` itself is untimed; nothing proved that no
 * code ever writes a trade to the timed neighbour instead. A one-off grep is a
 * fact about one day. This makes "stays" a claim that fails when it stops
 * being true.
 *
 * Tests are exempt: the collection suite reads `trade_logs`'s indexes to show
 * the contrast, which is the point of having it.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY = "packages/db/src/collections.ts";
/** A code reference — the registry key, or the name as a string literal. */
const USE = /\btradeLogs\b|["']trade_logs["']/;
const SOURCE = /\.(ts|tsx|mts|mjs)$/;

function sources(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : sources(path);
    }
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** Every source file in every package and app, as a repo-relative path. */
function allSources(): string[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        ["src", "scripts"].flatMap((sub) =>
          sources(join(ROOT, group, entry.name, sub)),
        ),
      )
      .map((path) => relative(ROOT, path).replaceAll("\\", "/")),
  );
}

const referencing = (): string[] =>
  allSources().filter((path) =>
    USE.test(readFileSync(join(ROOT, path), "utf8")),
  );

describe("trade_logs stays unused (§2.3)", () => {
  it("is referenced by nothing but its registry entry", () => {
    const offenders = referencing().filter(
      (path) => path !== REGISTRY && !/\.test\.tsx?$/.test(path),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The scan must be able to see a reference at all, or the assertion above
   * passes vacuously — a wrong ROOT would find no files and no offenders.
   */
  it("does see the registry entry, so an empty result means something", () => {
    expect(referencing()).toContain(REGISTRY);
  });
});
