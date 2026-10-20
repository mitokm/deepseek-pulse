/**
 * Minimal, dependency-free timezone helpers.
 *
 * The dashboard only needs: "what local day / hour / weekday is this instant"
 * and "when does the local day start". Both are derived through Intl so the
 * configured display zone works even when the host clock is elsewhere.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function createClock(timeZone) {
  const partsFormat = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });

  function parts(ms) {
    const out = {};
    for (const part of partsFormat.formatToParts(new Date(ms))) out[part.type] = part.value;
    return out;
  }

  /** Offset of `timeZone` from UTC at instant `ms`, in minutes. */
  function offsetMinutes(ms) {
    const p = parts(ms);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return (asUtc - Math.floor(ms / 1000) * 1000) / MINUTE;
  }

  function dateKey(ms) {
    const p = parts(ms);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function hour(ms) {
    return Number(parts(ms).hour);
  }

  function weekday(ms) {
    return WEEKDAY_INDEX[parts(ms).weekday] ?? 0;
  }

  /** UTC instant of the start of the local day containing `ms`. */
  function dayStart(ms) {
    const offset = offsetMinutes(ms);
    const local = ms + offset * MINUTE;
    return Math.floor(local / DAY) * DAY - offset * MINUTE;
  }

  function addDays(ms, days) {
    return ms + days * DAY;
  }

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  return { timeZone, offsetMinutes, dateKey, hour, weekday, dayStart, addDays, iso, DAY, MINUTE };
}
