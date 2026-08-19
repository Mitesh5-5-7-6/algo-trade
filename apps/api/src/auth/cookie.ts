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
  /**
   * Set when the dashboard and the API are on different registrable domains —
   * e.g. two `*.vercel.app` subdomains, which are separate *sites* because
   * `vercel.app` is on the Public Suffix List. A `SameSite=Lax` cookie is not
   * sent on cross-site XHR at all, so the session would simply never arrive.
   *
   * `SameSite=None` is the only value browsers send cross-site, and it gives
   * up the CSRF protection plan/21 §3 leans on. Prefer co-locating the two on
   * one registrable domain (`app.example.com` + `api.example.com`) and leaving
   * this off; reach for it only when that is genuinely not an option.
   */
  crossSite?: boolean;
}

/**
 * `SameSite=None` is meaningless — and rejected by browsers — without
 * `Secure`, so cross-site implies secure regardless of what was asked for.
 */
function sameSiteAttrs(secure: boolean, crossSite: boolean): string[] {
  if (!crossSite) return secure ? ["SameSite=Lax", "Secure"] : ["SameSite=Lax"];
  return ["SameSite=None", "Secure"];
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
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    ...sameSiteAttrs(options.secure, options.crossSite ?? false),
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ].join("; ");
}

/**
 * A cookie that deletes itself — logout / failed-resolution cleanup. The
 * attributes must match the ones it was set with or the browser keeps the
 * original: a clear that does not clear leaves a dead session id in place.
 */
export function clearSessionCookie(
  secure: boolean,
  crossSite = false,
): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    ...sameSiteAttrs(secure, crossSite),
    "Max-Age=0",
  ].join("; ");
}
