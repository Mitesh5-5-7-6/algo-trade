/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export (plan/04 §10, pinned 2026-07-05): the dashboard is purely
  // client-side talking to the Fastify API — no SSR runtime, no secrets in
  // the bundle (plan/06 §8), served as static assets behind the proxy
  // (plan/22 §2).
  output: "export",
  reactStrictMode: true,
};

export default nextConfig;
