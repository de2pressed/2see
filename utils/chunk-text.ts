const CHUNK_TRIGGER_CHARS = 48_000;
const TARGET_CHUNK_CHARS = 36_000;
const MAX_CHUNK_CHARS = 42_000;
const MIN_STANDALONE_CHUNK_CHARS = 500;

export function chunkText(text: string): string[] {
  const cleanText = text.replace(/\r\n/g, "\n").trim();

  if (cleanText.length <= CHUNK_TRIGGER_CHARS) {
    return [cleanText];
  }

  const sections = cleanText
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    if (section.length > MAX_CHUNK_CHARS) {
      flushChunk(chunks, current);
      current = "";

      for (const sentenceChunk of splitLongSection(section)) {
        flushChunk(chunks, sentenceChunk);
      }

      continue;
    }

    const candidate = current ? `${current}\n\n${section}` : section;

    if (candidate.length > TARGET_CHUNK_CHARS && current.length > 0) {
      flushChunk(chunks, current);
      current = section;
    } else {
      current = candidate;
    }
  }

  flushChunk(chunks, current);
  return mergeTinyChunks(chunks);
}

function splitLongSection(section: string): string[] {
  const sentences = section.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > TARGET_CHUNK_CHARS && current.length > 0) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function flushChunk(chunks: string[], chunk: string): void {
  const trimmed = chunk.trim();
  if (trimmed) {
    chunks.push(trimmed);
  }
}

function mergeTinyChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const merged: string[] = [];

  for (const chunk of chunks) {
    const previousIndex = merged.length - 1;
    if (
      chunk.length < MIN_STANDALONE_CHUNK_CHARS &&
      previousIndex >= 0 &&
      merged[previousIndex].length + chunk.length < MAX_CHUNK_CHARS
    ) {
      merged[previousIndex] = `${merged[previousIndex]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}
