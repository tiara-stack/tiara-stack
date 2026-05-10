export const defaultTimeoutCleanupGraceMs = 5_000;

export const runWithAbortTimeout = <A>(input: {
  readonly runPromise: Promise<A>;
  readonly abort: () => void;
  readonly timeoutMs?: number;
  readonly cleanupGraceMs?: number;
  readonly timeoutError: () => unknown;
}) => {
  if (input.timeoutMs === undefined) {
    return input.runPromise;
  }
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      input.abort();
      const cleanupTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(input.timeoutError());
        }
      }, input.cleanupGraceMs ?? defaultTimeoutCleanupGraceMs);
      void input.runPromise.then(
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(cleanupTimeout);
            reject(input.timeoutError());
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(cleanupTimeout);
            reject(input.timeoutError());
          }
        },
      );
    }, input.timeoutMs);
    input.runPromise.then(
      (value) => {
        if (!timedOut && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        }
      },
      (cause) => {
        if (!timedOut && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(cause);
        }
      },
    );
  });
};
