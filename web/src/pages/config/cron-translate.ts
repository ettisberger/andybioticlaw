/**
 * Tiny dependency-free translator for the cron patterns we actually
 * use in this project. Covers:
 *
 *   - `m h * * *`           → "daily at HH:MM"
 *   - `m h * * 0-6`         → "every day at HH:MM" (same as above)
 *   - `m h * * 1-5`         → "weekdays at HH:MM"
 *   - `m h * * 1`           → "Mondays at HH:MM" (etc.)
 *   - `*‎/N * * * *`         → "every N minutes"
 *   - `0 *‎/N * * *`         → "every N hours"
 *   - anything else         → returns null (caller renders raw)
 *
 * NOT a full cron parser. If we ever need anything more exotic we swap
 * in `cronstrue`, but for 2-3 fields in our config this is plenty.
 */
export function humanizeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];

  // every N minutes: `*/N * * * *`
  const minMatch = m.match(/^\*\/(\d+)$/);
  if (minMatch && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(minMatch[1]);
    return n === 1 ? 'every minute' : `every ${n} minutes`;
  }

  // every N hours on the minute: `M */N * * *`
  const hourMatch = h.match(/^\*\/(\d+)$/);
  if (hourMatch && /^\d+$/.test(m) && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(hourMatch[1]);
    return n === 1 ? 'every hour' : `every ${n} hours`;
  }

  // Fixed time: need both m and h to be integers.
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || dom !== '*' || mon !== '*') return null;
  const hh = Number(h).toString().padStart(2, '0');
  const mm = Number(m).toString().padStart(2, '0');
  const time = `${hh}:${mm}`;

  if (dow === '*' || dow === '0-6' || dow === '*/1') {
    return `daily at ${time}`;
  }
  if (dow === '1-5') return `weekdays at ${time}`;
  if (dow === '0,6' || dow === '6,0') return `weekends at ${time}`;
  const singleDow = dow.match(/^\d$/);
  if (singleDow) {
    const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    return `${names[Number(singleDow[0])]} at ${time}`;
  }
  return null;
}
