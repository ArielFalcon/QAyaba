/*
 * In-process fixed-window limiter for unauthenticated POST /api/auth/login.
 * That route makes outbound GitHub calls; unbounded flood would amplify from the server IP.
 */

export interface RateLimiter {
  allow(key: string, now?: number): boolean;
}

interface Window {
  start: number;
  count: number;
}

const MAX_KEYS = 10_000;

export function createFixedWindowLimiter(opts: { limit: number; windowMs: number }): RateLimiter {
  const { limit, windowMs } = opts;
  const windows = new Map<string, Window>();

  function prune(now: number): void {
    for (const [key, w] of windows) {
      if (now - w.start >= windowMs) windows.delete(key);
    }
  }

  return {
    allow(key: string, now = Date.now()): boolean {
      if (windows.size > MAX_KEYS) prune(now);
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      if (w.count >= limit) return false;
      w.count++;
      return true;
    },
  };
}
