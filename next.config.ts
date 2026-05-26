import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  // pdf.js resolves these at runtime, so Vercel's file tracer needs explicit includes.
  outputFileTracingIncludes: {
    "/api/extract-claims": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
  },
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
