/**
 * Runs `work` over `items` with at most `width` in flight, results in item order. The verifier's
 * queries each start z3 processes, so a pool is how many solvers run at once.
 */
export async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}
