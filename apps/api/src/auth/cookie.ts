/**
 * Minimal cookie read/serialize — the session cookie is the only one we set, so
 * a dependency-free helper beats pulling in a plugin. The security attributes
 * are not optional (plan/21 §3): HttpOnly keeps the token out of reach of XSS
 * (it is never in `document.cookie`/JS), SameSite blunts CSRF, Secure keeps it
 * off plaintext HTTP in production.
 */
export const SESSION_COOKIE = "nk_session";

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function serializeSessionCookie(
  value: string,
  options: CookieOptions,
): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ];
  if (options.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** A cookie that deletes itself — logout / failed-resolution cleanup. */
export function clearSessionCookie(secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
