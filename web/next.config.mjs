/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

const nextConfig = {
  // Both this directory and the repo root have a lockfile — web/ needs its own
  // so Vercel can build with `web` as the root directory. Pin the workspace
  // root so Turbopack stops guessing (and guessing wrong).
  turbopack: {
    root: import.meta.dirname,
  },

  // Proxy the API through this origin. Same-origin means no CORS preflight on
  // the SSE endpoint, and no API host baked into the client bundle.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/health', destination: `${API_ORIGIN}/health` },
    ];
  },
};

export default nextConfig;