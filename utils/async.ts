export function delay(ms: number): Promise<void> {
  const isTest = typeof process !== "undefined" && (process.env.NODE_ENV === "test" || !!process.env.VITEST);
  const delayMs = isTest ? 0 : ms;
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}
