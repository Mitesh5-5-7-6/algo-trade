import { describe, expect, it } from "vitest";
import { isCrossSite } from "./same-site.js";

/**
 * This decides `SameSite` on the session cookie, so getting it wrong is not
 * cosmetic: too strict and every authenticated request silently 401s, too
 * loose and CSRF protection is given away for nothing.
 */
describe("isCrossSite (decides SameSite on the session cookie)", () => {
  it("treats two *.vercel.app subdomains as DIFFERENT sites", () => {
    // vercel.app is a public suffix, so these are not siblings under one site.
    // A Lax cookie set by one is never sent to the other.
    expect(
      isCrossSite(
        "https://algo-trade-dashboard-three.vercel.app",
        "https://algo-trade-api-three.vercel.app",
      ),
    ).toBe(true);
  });

  it("treats app./api. subdomains of one real domain as the SAME site", () => {
    expect(
      isCrossSite("https://app.example.com", "https://api.example.com"),
    ).toBe(false);
  });

  it("is same-site for identical origins", () => {
    expect(
      isCrossSite("https://example.com", "https://example.com"),
    ).toBe(false);
  });

  it("handles the other PSL hosts a deploy might land on", () => {
    expect(
      isCrossSite("https://a.netlify.app", "https://b.netlify.app"),
    ).toBe(true);
    expect(isCrossSite("https://a.pages.dev", "https://b.pages.dev")).toBe(true);
    expect(isCrossSite("https://a.fly.dev", "https://b.fly.dev")).toBe(true);
  });

  it("assumes cross-site when the API origin is unknown", () => {
    // Fail toward "works but weaker CSRF" rather than "silently cannot log in".
    expect(isCrossSite("https://app.example.com", undefined)).toBe(true);
    expect(isCrossSite("https://app.example.com", "")).toBe(true);
  });

  it("assumes cross-site rather than throwing on an unparseable origin", () => {
    expect(isCrossSite("https://app.example.com", "not-a-url")).toBe(true);
  });

  it("ignores port and case, which do not define a site here", () => {
    expect(
      isCrossSite("https://APP.example.com:3000", "https://api.example.com"),
    ).toBe(false);
  });

  it("separates genuinely different domains", () => {
    expect(
      isCrossSite("https://app.example.com", "https://api.other.com"),
    ).toBe(true);
  });
});
