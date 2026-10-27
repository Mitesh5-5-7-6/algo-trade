import { describe, expect, it } from "vitest";
import { brokerChip } from "./broker-status.js";

/** A broken or silent feed must never look like a healthy one (plan/06 §7). */
const base = { name: "FYERS", connected: true, state: "connected" as const };

describe("the broker chip", () => {
  it("reads LIVE only while connected and delivering", () => {
    expect(brokerChip(base)).toEqual({ label: "FEED LIVE", dot: "ok" });
  });

  it("reads SILENT, not LIVE, for a connected feed delivering nothing", () => {
    expect(brokerChip({ ...base, silentSeconds: 95 })).toEqual({
      label: "FEED SILENT 95s",
      dot: "warn",
    });
  });

  it("reads NO FEED the moment the feed drops", () => {
    expect(
      brokerChip({ ...base, connected: false, state: "disconnected" }),
    ).toEqual({ label: "NO FEED", dot: "bad" });
    expect(
      brokerChip({ ...base, connected: false, state: "connecting" }),
    ).toEqual({ label: "CONNECTING…", dot: "bad" });
  });
});
