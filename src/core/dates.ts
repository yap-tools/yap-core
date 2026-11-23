/**
 * Date input. A `date` property, and a filter on one, takes exactly two forms:
 *
 *   - a bare day, `YYYY-MM-DD`, stored as midnight UTC of that day;
 *   - a full timestamp with an explicit zone,
 *     `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by `Z` or `±HH:MM`,
 *     stored as that instant in UTC.
 *
 * Both are stored as one canonical ISO-8601 UTC string
 * (`2026-11-16T08:00:00.000Z`), so stored dates sort and compare as text.
 *
 * Everything else is refused, including forms `Date.parse` would take: a
 * timestamp without a zone (which `Date.parse` reads in the server's local
 * time, so the same input stores a different instant per host), `Nov 16,
 * 2026`, `2026/11/16`, RFC 2822, a year alone. Impossible calendar values in
 * an accepted form (`2026-02-30`, `T24:00`) are refused instead of rolled
 * over. The instant is computed from the parsed fields with UTC arithmetic
 * only, never through the host's zone. Fractions beyond milliseconds are
 * truncated, as `Date` does.
 */

/** What to send instead; appended to every refusal. */
export const DATE_INPUT_HINT =
  "send YYYY-MM-DD for a day, or a timestamp with Z or an offset (e.g. 2026-11-16T09:00:00+01:00)";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Milliseconds since the epoch for a UTC calendar time; years 0-99 kept as-is. */
function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, ms);
  return d.getTime();
}

/**
 * Parses a date input into its stored form, or returns null when the value is
 * not one of the two accepted forms or names an impossible date or time.
 */
export function parseDateInput(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const day = DAY.exec(value);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    if (month < 1 || month > 12 || date < 1 || date > daysInMonth(year, month)) return null;
    return new Date(utcMs(year, month, date)).toISOString();
  }

  const ts = TIMESTAMP.exec(value);
  if (!ts) return null;
  const year = Number(ts[1]);
  const month = Number(ts[2]);
  const date = Number(ts[3]);
  const hour = Number(ts[4]);
  const minute = Number(ts[5]);
  const second = ts[6] === undefined ? 0 : Number(ts[6]);
  const ms = ts[7] === undefined ? 0 : Number(ts[7].slice(0, 3).padEnd(3, "0"));
  if (month < 1 || month > 12 || date < 1 || date > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (ts[8] !== "Z") {
    const offHours = Number(ts[10]);
    const offMinutes = Number(ts[11]);
    if (offHours > 23 || offMinutes > 59) return null;
    offsetMinutes = (ts[9] === "-" ? -1 : 1) * (offHours * 60 + offMinutes);
  }
  const instant = utcMs(year, month, date, hour, minute, second, ms) - offsetMinutes * 60_000;
  // An offset can carry the instant out of years 0000-9999, where the stored
  // form would gain a sign and six digits and stop sorting as text.
  const out = new Date(instant).toISOString();
  return out.length === 24 ? out : null;
}
