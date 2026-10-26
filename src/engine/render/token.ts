/** A small cooperative cancellation primitive shared by the engine and the UI. */
export class CancellationToken {
  private controller = new AbortController();
  private cancelReason: string | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get reason(): string | undefined {
    return this.cancelReason;
  }

  cancel(reason = 'cancelado pelo utilizador'): void {
    if (this.controller.signal.aborted) return;
    this.cancelReason = reason;
    this.controller.abort(reason);
  }
}

/** Waits `ms`, resolving early (with `false`) when the token is cancelled. */
export function delay(ms: number, token?: CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token?.cancelled) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      token?.signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    token?.signal.addEventListener('abort', onAbort, { once: true });
  });
}
