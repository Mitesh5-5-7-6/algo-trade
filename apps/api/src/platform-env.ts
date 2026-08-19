/**
 * Translate a PaaS's port convention onto our own names (plan/22 §2).
 *
 * Render, Railway, Fly and Heroku all inject `PORT` and expect the process to
 * bind it on ALL interfaces — the platform's router reaches the container from
 * outside. Our defaults are `127.0.0.1:4000`, which is right for a laptop and
 * fatal on a PaaS: the process starts, looks healthy in its own logs, and the
 * platform reports "no open ports detected" because nothing is listening where
 * it looked.
 *
 * `PORT` is the signal that we are in such a container, so it also flips the
 * bind address. Explicit `API_HOST`/`API_PORT` always win — this only fills in
 * what was not set, and the config schema stays platform-neutral.
 */
export function platformEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const port = env["PORT"];
  if (port === undefined || port.length === 0) return env;
  return {
    ...env,
    API_PORT: env["API_PORT"] ?? port,
    API_HOST: env["API_HOST"] ?? "0.0.0.0",
  };
}
