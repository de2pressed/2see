import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SearchFixtureResult = {
  title: string;
  url: string;
  snippet: string;
};

function fixtureKey(query: string): string {
  return createHash("sha256").update(query.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function getSearchFixturesDir(): string | null {
  const dir = process.env.SEARCH_FIXTURES_DIR?.trim();
  return dir && dir.length > 0 ? dir : null;
}

export function loadSearchFixture(query: string): SearchFixtureResult[] | null {
  const dir = getSearchFixturesDir();
  if (!dir) {
    return null;
  }

  const filePath = join(dir, `${fixtureKey(query)}.json`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed
      .filter(
        (item): item is SearchFixtureResult =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as SearchFixtureResult).title === "string" &&
          typeof (item as SearchFixtureResult).url === "string" &&
          typeof (item as SearchFixtureResult).snippet === "string",
      )
      .map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
      }));
  } catch {
    return null;
  }
}
