export async function scheduleTools<T, R>(calls: T[], independent: (call: T) => boolean, run: (call: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < calls.length;) {
    const call = calls[i];
    if (call === undefined) break;
    if (concurrency <= 1 || !independent(call)) { results[i] = await run(call); i++; continue; }
    let end = i + 1;
    for (let next = calls[end]; next !== undefined && independent(next); next = calls[end]) end++;
    let next = i;
    await Promise.all(Array.from({ length: Math.min(concurrency, end - i) }, async () => {
      while (next < end) {
        const index = next++;
        const item = calls[index];
        if (item !== undefined) results[index] = await run(item);
      }
    }));
    i = end;
  }
  return results;
}
