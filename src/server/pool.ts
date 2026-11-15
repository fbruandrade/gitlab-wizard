import 'server-only';

/** Executa `fn` sobre os itens com no máximo `concurrency` em paralelo (preserva a ordem de início). */
export async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
