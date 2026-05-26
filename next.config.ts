import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { NextConfig } from "next";

const requireFromConfig = createRequire(import.meta.url);
const pdfWorkerSource = requireFromConfig.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
const copyPdfWorkerPluginName = "CopyPdfJsWorkerPlugin";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  // pdf.js resolves these at runtime, so Vercel's file tracer needs explicit includes.
  outputFileTracingIncludes: {
    "/api/extract-claims": [
      "./.next/server/chunks/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
  },
  webpack(config, { isServer }) {
    if (isServer) {
      config.plugins.push({
        apply(compiler) {
          compiler.hooks.afterEmit.tap(copyPdfWorkerPluginName, () => {
            const outputPath = compiler.options.output.path;
            if (!outputPath) {
              return;
            }

            const workerDestination = path.join(outputPath, "chunks", "pdf.worker.mjs");
            mkdirSync(path.dirname(workerDestination), { recursive: true });
            copyFileSync(pdfWorkerSource, workerDestination);
          });
        },
      });
    }

    return config;
  },
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
