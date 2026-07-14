/**
 * Where the API lives. Empty by default: in production the dashboard is served
 * same-origin behind the reverse proxy (plan/22 §2), so relative paths hit the
 * API with the session cookie attached. In dev the two run on different ports,
 * so `NEXT_PUBLIC_API_BASE=http://localhost:4000` points the client at Fastify
 * (which allows that origin with credentials — plan/21, CORS in the API).
 */
export const API_BASE = process.env["NEXT_PUBLIC_API_BASE"] ?? "";
