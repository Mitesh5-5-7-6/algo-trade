import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
} from "./cookie.js";

describe("session cookie attributes (plan/21 §3)", () => {
  it("is always HttpOnly and scoped to the whole origin", () => {
    const cookie = serializeSessionCookie("abc", {
      maxAgeSeconds: 900,
      secure: true,
    });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=900");
  });

  it("defaults to SameSite=Lax — CSRF protection unless told otherwise", () => {
    const cookie = serializeSessionCookie("abc", {
      maxAgeSeconds: 900,
      secure: true,
    });
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=None");
  });

  it("omits Secure in dev, where the API is plain HTTP", () => {
    const cookie = serializeSessionCookie("abc", {
      maxAgeSeconds: 900,
      secure: false,
    });
    expect(cookie).not.toContain("Secure");
  });

  it("uses SameSite=None cross-site — Lax is never sent on cross-site XHR", () => {
    const cookie = serializeSessionCookie("abc", {
      maxAgeSeconds: 900,
      secure: true,
      crossSite: true,
    });
    expect(cookie).toContain("SameSite=None");
    expect(cookie).not.toContain("SameSite=Lax");
  });

  it("forces Secure alongside SameSite=None, which browsers reject without it", () => {
    const cookie = serializeSessionCookie("abc", {
      maxAgeSeconds: 900,
      secure: false, // asked for insecure...
      crossSite: true,
    });
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure"); // ...but None makes it non-negotiable
  });

  it("url-encodes the value so a stray ';' cannot forge attributes", () => {
    const cookie = serializeSessionCookie("a;b c", {
      maxAgeSeconds: 60,
      secure: true,
    });
    expect(cookie).toContain(`${SESSION_COOKIE}=a%3Bb%20c`);
  });
});

describe("clearSessionCookie", () => {
  it("expires immediately", () => {
    expect(clearSessionCookie(true)).toContain("Max-Age=0");
    expect(clearSessionCookie(true)).toContain(`${SESSION_COOKIE}=;`);
  });

  it("matches the SameSite it was set with, or the browser keeps the original", () => {
    expect(clearSessionCookie(true, true)).toContain("SameSite=None");
    expect(clearSessionCookie(true, false)).toContain("SameSite=Lax");
  });
});

describe("readCookie", () => {
  it("finds the session among other cookies", () => {
    expect(readCookie("a=1; nk_session=xyz; b=2", SESSION_COOKIE)).toBe("xyz");
  });

  it("decodes what serialize encoded — a round trip", () => {
    const cookie = serializeSessionCookie("a;b c", {
      maxAgeSeconds: 60,
      secure: true,
    });
    const value = cookie.slice(0, cookie.indexOf(";"));
    expect(readCookie(value, SESSION_COOKIE)).toBe("a;b c");
  });

  it("returns undefined when absent or when there is no cookie header", () => {
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});
