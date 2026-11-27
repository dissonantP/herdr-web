/** Sends by client message id, so a retry never delivers twice: a running or lately finished send is shared; a failed one may be retried. */
export function createSendOnce(memoryMs = 10 * 60_000) {
  const sends = new Map<string, Promise<void>>();
  return {
    once(key: string, deliver: () => Promise<void>): Promise<void> {
      const known = sends.get(key);
      if (known !== undefined) return known;
      const run = deliver();
      sends.set(key, run);
      run.then(
        () => void setTimeout(() => sends.delete(key), memoryMs).unref(),
        () => sends.delete(key),
      );
      return run;
    },
  };
}
