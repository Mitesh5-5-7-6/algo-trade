import { describe, expect, it } from "vitest";
import { windowClosed } from "./store.js";

/** Task 12.3 (Phase 12 design D6): a test waits for its window to close. */
describe("whether an out-of-sample window has closed (12.3, D6)", () => {
  it("is closed when every instrument has a session on or after its last day", () => {
    expect(
      windowClosed("2026-09-28", {
        "NSE:A": "2026-09-28",
        "NSE:B": "2026-09-30",
      }),
    ).toEqual({ closed: true, behind: [] });
  });

  it("is open while any instrument stops before it — naming which, and where", () => {
    expect(
      windowClosed("2026-09-28", {
        "NSE:B": "2026-09-25",
        "NSE:A": "2026-09-28",
      }),
    ).toEqual({ closed: false, behind: ["NSE:B (last session 2026-09-25)"] });
  });

  it("keeps a window ending on a non-trading day open until the next session exists", () => {
    // 2026-09-27 is a Sunday: Friday's session is not past it.
    expect(windowClosed("2026-09-27", { "NSE:A": "2026-09-25" }).closed).toBe(
      false,
    );
    expect(windowClosed("2026-09-27", { "NSE:A": "2026-09-28" }).closed).toBe(
      true,
    );
  });

  it("is open for an instrument with no data at all", () => {
    expect(windowClosed("2026-09-28", { "NSE:A": null })).toEqual({
      closed: false,
      behind: ["NSE:A (last session none)"],
    });
  });
});
