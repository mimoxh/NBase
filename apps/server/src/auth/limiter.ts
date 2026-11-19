/** Counts failures per client address in a fixed window; once full, new addresses are refused too. */
export class FailureLimiter {
  private readonly failures = new Map<string, { count: number; resetsAt: number }>();

  constructor(private readonly maxFailures: number, private readonly windowMs: number, private readonly maxKeys = 10000) {}

  blocked(key: string, now = Date.now()): boolean {
    const state = this.failures.get(key);
    if (state && state.resetsAt <= now) this.failures.delete(key);
    if (this.failures.size >= this.maxKeys) this.prune(now);
    return (this.failures.get(key)?.count ?? 0) >= this.maxFailures || (this.failures.size >= this.maxKeys && !this.failures.has(key));
  }

  fail(key: string, now = Date.now()): void {
    const state = this.failures.get(key);
    if (!state || state.resetsAt <= now) this.failures.set(key, { count: 1, resetsAt: now + this.windowMs });
    else state.count += 1;
  }

  succeed(key: string): void { this.failures.delete(key); }

  private prune(now: number): void {
    for (const [key, state] of this.failures) if (state.resetsAt <= now) this.failures.delete(key);
  }
}
