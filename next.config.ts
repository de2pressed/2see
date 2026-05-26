import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["@react-pdf/renderer", "@napi-rs/canvas"],
};

export default nextConfig;
