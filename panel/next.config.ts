import os from "node:os";
import type { NextConfig } from "next";

const host = os.hostname().toLowerCase();
const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && !a.internal && a.family === "IPv4")
  .map((a) => a!.address);

const nextConfig: NextConfig = {
  // Everything here is live data from ssh; there is nothing worth prerendering,
  // so Cache Components stays off.
  devIndicators: false,
  serverExternalPackages: ["node-pty"],
  // Let phones on the LAN use the dev server too (production needs no allowlist).
  allowedDevOrigins: [host, `${host}.local`, ...addresses],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
