import path from "path";
import { pathToFileURL } from "url";
import { TEXT_EXTRACTION_ERROR } from "@/utils/files";

export interface PageBlock {
  pageNumber: number;
  text: string;
}

type PositionedTextItem = {
  str: string;
  x: number;
  y: number;
  height: number;
};

function polyfillBrowserAPIs(): void {
  if (typeof globalThis.DOMMatrix === "undefined") {
    class DOMMatrixPolyfill {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;

      constructor(init?: string | number[] | Float64Array | Float32Array) {
        if (init) {
          const m = typeof init === "string"
            ? init.replace(/matrix/i, "").replace(/[()]/g, "").trim().split(/[,\s]+/).map(Number)
            : Array.from(init);
          if (m.length >= 6) {
            this.a = m[0]; this.b = m[1]; this.c = m[2]; this.d = m[3]; this.e = m[4]; this.f = m[5];
          }
        }
      }

      multiplySelf(other: DOMMatrixPolyfill) { return this; }
      preMultiplySelf(other: DOMMatrixPolyfill) { return this; }
      translateSelf(x: number, y: number) { return this; }
      scaleSelf(x: number, y: number) { return this; }
      invertSelf() { return this; }
      translate(x: number, y: number) { return this; }
      scale(x: number, y: number) { return this; }
      rotateFromVectorSelf(x: number, y: number) { return this; }
    }
    (globalThis as unknown as Record<string, unknown>).DOMMatrix = DOMMatrixPolyfill;
  }

  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    class DOMMatrixReadOnlyPolyfill {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;

      constructor(init?: string | number[]) {
        if (init) {
          const m = typeof init === "string"
            ? init.replace(/matrix/i, "").replace(/[()]/g, "").trim().split(/[,\s]+/).map(Number)
            : init;
          if (m.length >= 6) {
            this.a = m[0]; this.b = m[1]; this.c = m[2]; this.d = m[3]; this.e = m[4]; this.f = m[5];
          }
        }
      }
    }
    (globalThis as unknown as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyPolyfill;
  }

  if (typeof globalThis.ImageData === "undefined") {
    class ImageDataPolyfill {
      width: number;
      height: number;
      data: Uint8ClampedArray;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    }
    (globalThis as unknown as Record<string, unknown>).ImageData = ImageDataPolyfill as unknown as typeof ImageData;
  }

  if (typeof globalThis.Path2D === "undefined") {
    class Path2DPolyfill {
      addPath() { /* noop */ }
      closePath() { /* noop */ }
      moveTo() { /* noop */ }
      lineTo() { /* noop */ }
      arc() { /* noop */ }
      bezierCurveTo() { /* noop */ }
      quadraticCurveTo() { /* noop */ }
      rect() { /* noop */ }
    }
    (globalThis as unknown as Record<string, unknown>).Path2D = Path2DPolyfill as unknown as typeof Path2D;
  }
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<PageBlock[]> {
  polyfillBrowserAPIs();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  
  // Explicitly set the worker source to the absolute path of pdf.worker.mjs
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.mjs"
  )).toString();

  const loadingTask = pdfjs.getDocument({
    // Copy bytes; pdf.js may transfer the underlying ArrayBuffer to its worker.
    data: new Uint8Array(buffer.slice(0)),
    disableFontFace: true,
    useSystemFonts: true,
  });

  const document = await loadingTask.promise;
  const pages: PageBlock[] = [];
  let totalLength = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = buildContextualPageText(content.items);

    if (pageText) {
      pages.push({ pageNumber, text: pageText });
      totalLength += pageText.length;
    }
  }

  if (totalLength < 100) {
    throw new Error(TEXT_EXTRACTION_ERROR);
  }

  return pages;
}

function buildContextualPageText(items: unknown[]): string {
  const positioned = items
    .map(toPositionedTextItem)
    .filter((item): item is PositionedTextItem => item !== null);

  if (positioned.length === 0) {
    return "";
  }

  const lines = groupTextItemsIntoLines(positioned);
  return markLikelySectionHeadings(lines).join("\n").trim();
}

function toPositionedTextItem(item: unknown): PositionedTextItem | null {
  if (typeof item !== "object" || item === null || !("str" in item)) {
    return null;
  }

  const record = item as {
    str?: unknown;
    transform?: unknown;
    height?: unknown;
  };
  const str = typeof record.str === "string" ? record.str.trim() : "";
  if (!str) {
    return null;
  }

  const transform = Array.isArray(record.transform) ? record.transform : [];
  const x = typeof transform[4] === "number" ? transform[4] : 0;
  const y = typeof transform[5] === "number" ? transform[5] : 0;
  const height = typeof record.height === "number"
    ? record.height
    : typeof transform[3] === "number"
      ? Math.abs(transform[3])
      : 0;

  return { str, x, y, height };
}

function groupTextItemsIntoLines(items: PositionedTextItem[]): string[] {
  const sorted = [...items].sort((a, b) => {
    const yDiff = b.y - a.y;
    if (Math.abs(yDiff) > 2.5) {
      return yDiff;
    }
    return a.x - b.x;
  });

  const lines: PositionedTextItem[][] = [];

  for (const item of sorted) {
    const line = lines.find((candidate) => {
      const first = candidate[0];
      const tolerance = Math.max(2.5, first.height * 0.45, item.height * 0.45);
      return Math.abs(first.y - item.y) <= tolerance;
    });

    if (line) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }

  return lines
    .map((line) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str)
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function markLikelySectionHeadings(lines: string[]): string[] {
  return lines.map((line) => {
    if (!isLikelySectionHeading(line)) {
      return line;
    }
    return `## ${line.replace(/^#+\s*/, "")}`;
  });
}

function isLikelySectionHeading(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 14) {
    return false;
  }

  if (/[.!?:;]$/.test(line) || /\$?\d+(?:\.\d+)?\s*(?:%|million|billion|trillion|gb|mwh|twh)/i.test(line)) {
    return false;
  }

  const letters = line.replace(/[^a-z]/gi, "");
  if (letters.length < 4) {
    return false;
  }

  const uppercaseRatio = line.replace(/[^A-Z]/g, "").length / letters.length;
  const titleCaseWords = words.filter((word) => /^[A-Z][a-z0-9&-]+/.test(word)).length;

  return uppercaseRatio > 0.55 || titleCaseWords / words.length > 0.65;
}
