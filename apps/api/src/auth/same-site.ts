/**
 * Deciding `SameSite` on the session cookie (plan/21 §3).
 *
 * A browser sends a `SameSite=Lax` cookie only to the *same site* — and "site"
 * is the registrable domain, not the origin. `app.example.com` and
 * `api.example.com` share the site `example.com`, so Lax works and CSRF
 * protection is kept. But hosts under a Public Suffix List entry do NOT share
 * a site: `a.vercel.app` and `b.vercel.app` are as unrelated to a browser as
 * two different companies. A Lax cookie set by one is never sent to the other,
 * so a dashboard and an API split across two `*.vercel.app` deployments cannot
 * hold a session at all until the cookie becomes `SameSite=None`.
 *
 * Lives beside `cookie.ts` because both the long-lived server and the
 * serverless app need the same answer, and a second copy of this rule that
 * disagreed would be an authentication bug nobody could see.
 */

/**
 * Public-suffix entries this system realistically deploys under, where the
 * full subdomain is itself the site. Not the whole PSL — just the hosts that
 * would otherwise be silently mis-classified as same-site. Ordinary domains
 * fall through to the last-two-labels rule below.
 */
const PUBLIC_SUFFIXES = [
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "github.io",
  "onrender.com",
  "fly.dev",
];

/** The registrable domain — what a browser treats as "the site". */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase();
  for (const suffix of PUBLIC_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return host;
  }
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

/**
 * Whether the dashboard and the API are different sites.
 *
 * Unknown or unparseable API origin ⇒ assume cross-site. The two failure modes
 * are not symmetric: guessing "cross-site" wrongly costs CSRF hardening, while
 * guessing "same-site" wrongly means the session cookie is never sent and
 * every authenticated request 401s with nothing in the logs to explain it.
 */
export function isCrossSite(
  dashboardOrigin: string,
  apiOrigin: string | undefined,
): boolean {
  if (apiOrigin === undefined || apiOrigin.length === 0) return true;
  try {
    return (
      siteOf(new URL(dashboardOrigin).hostname) !==
      siteOf(new URL(apiOrigin).hostname)
    );
  } catch {
    return true;
  }
}
