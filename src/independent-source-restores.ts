/** Start each saved source immediately; a cloud provider may never settle one of them. */
export function startIndependentSourceRestores<T>(items: readonly T[], restore: (item: T) => Promise<void>, onError: (item: T, error: unknown) => void): void {
  for (const item of items) {
    void Promise.resolve().then(() => restore(item)).catch((error: unknown) => onError(item, error))
  }
}
