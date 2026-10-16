interface Waiter { names: string[]; holder: string; grant: (release: () => void) => void }

/** Named locks for jobs (FR-4.3). A job takes all its locks at once or none, so jobs cannot deadlock. */
export class Locks {
  readonly held = new Map<string, string>();
  private waiters: Waiter[] = [];
  private onChange: (held: Record<string, string>) => void;

  constructor(onChange: (held: Record<string, string>) => void = () => {}) {
    this.onChange = onChange;
  }

  acquire(names: string[], holder: string, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const w: Waiter = { names, holder, grant: resolve };
      this.waiters.push(w);
      signal?.addEventListener('abort', () => {
        if (!this.waiters.includes(w)) return;
        this.waiters = this.waiters.filter(x => x !== w);
        this.pump();
        reject(signal.reason);
      }, { once: true });
      this.pump();
    });
  }

  private pump() {
    // FIFO: a later waiter may not take a lock an earlier waiter is still waiting for, so nobody starves.
    const wanted = new Set<string>();
    for (const w of [...this.waiters]) {
      if (w.names.some(n => this.held.has(n) || wanted.has(n))) {
        w.names.forEach(n => wanted.add(n));
        continue;
      }
      this.waiters = this.waiters.filter(x => x !== w);
      w.names.forEach(n => this.held.set(n, w.holder));
      let released = false;
      w.grant(() => {
        if (released) return;
        released = true;
        w.names.forEach(n => this.held.delete(n));
        this.onChange(Object.fromEntries(this.held));
        this.pump();
      });
    }
    this.onChange(Object.fromEntries(this.held));
  }
}
