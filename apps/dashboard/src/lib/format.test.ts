import { describe, expect, it } from "vitest";
import {
  formatIN,
  formatINR,
  formatPct,
  formatSignedINR,
  formatTimeIST,
} from "./format.js";

describe("Indian number formatting (Sentinel design)", () => {
  it("groups by lakh/crore exactly as the design shows", () => {
    expect(formatIN(600_000)).toBe("6,00,000");
    expect(formatIN(25_000)).toBe("25,000");
    expect(formatIN(12_345_678)).toBe("1,23,45,678");
  });

  it("renders rupee values with the design's minus sign", () => {
    expect(formatINR(-18_683)).toBe("−₹18,683");
    expect(formatINR(20_540)).toBe("₹20,540");
  });

  it("signs P&L values explicitly", () => {
    expect(formatSignedINR(1_857)).toBe("+₹1,857");
    expect(formatSignedINR(-20_540)).toBe("−₹20,540");
    expect(formatSignedINR(0)).toBe("+₹0");
  });

  it("renders percentages of the loss limit", () => {
    expect(formatPct(0.82)).toBe("82%");
    expect(formatPct(1)).toBe("100%");
  });

  it("renders IST clock time regardless of host timezone", () => {
    // 2026-07-05 08:12:27 UTC == 13:42:27 IST
    const ts = Date.UTC(2026, 6, 5, 8, 12, 27);
    expect(formatTimeIST(ts)).toBe("13:42:27");
    expect(formatTimeIST(ts, false)).toBe("13:42");
  });
});
