/** Run contiguous independent calls concurrently; barriers never overlap either side.
 * Results retain input order. Drain active work before propagating a runner error. */
export async function scheduleTools<T, R>(calls: T[], independent: (call: T) => boolean,
  run: (call: T) => Promise<R>, concurrency = 1): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("invalid tool concurrency");
  const results: R[] = [];
  for (let i = 0; i < calls.length;) {
    if (concurrency === 1 || !independent(calls[i]!)) { results[i] = await run(calls[i]!); i++; continue; }
    let end = i + 1;
    while (end < calls.length && independent(calls[end]!)) end++;
    let next = i;
    let failed = false;
    let error: unknown;
    await Promise.all(Array.from({ length: Math.min(concurrency, end - i) }, async () => {
      while (!failed && next < end) {
        const index = next++;
        try { results[index] = await run(calls[index]!); }
        catch (e) { failed = true; error = e; }
      }
    }));
    if (failed) throw error;
    i = end;
  }
  return results;
}
