import { createClock } from './time.mjs';

/**
 * DeepSeek billing model.
 *
 * Peak = 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese
 * public holidays (Asia/Shanghai dates). Every other instant is off-peak and
 * costs half the peak rate. Prices are per 1M tokens, USD.
 */

const CN_TZ = 'Asia/Shanghai';

export function createPricing(config, clock = createClock(config.displayTimeZone)) {
  const { perMillion, modelAliases = {}, fallbackModel, unit = 1_000_000 } = config.pricing;
  const { windowsUTC, weekdaysUTC = [1, 2, 3, 4, 5], excludeHolidays, holidaysCST = [] } = config.peakSchedule;

  const holidays = new Set(excludeHolidays === false ? [] : holidaysCST);
  const peakWeekdays = new Set(weekdaysUTC);
  const cnClock = createClock(CN_TZ);

  function isHoliday(ms) {
    return holidays.size > 0 && holidays.has(cnClock.dateKey(ms));
  }

  function isPeak(ms) {
    const d = new Date(ms);
    if (!peakWeekdays.has(d.getUTCDay())) return false;
    if (isHoliday(ms)) return false;
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    for (const window of windowsUTC) {
      const start = window.start * 60;
      const end = window.end * 60;
      if (minutes >= start && minutes < end) return true;
    }
    return false;
  }

  function band(ms) {
    return isPeak(ms) ? 'peak' : 'offPeak';
  }

  function rowFor(model) {
    return perMillion[modelAliases[model] ?? model] ?? perMillion[fallbackModel];
  }

  function costOf(event, bandOverride) {
    const row = rowFor(event.model);
    const b = bandOverride ?? band(event.time);
    const miss = (event.input ?? 0) + (event.cacheWrite ?? 0);
    return (
      ((event.cacheRead ?? 0) * row.cacheHit[b] + miss * row.cacheMiss[b] + (event.output ?? 0) * row.output[b]) / unit
    );
  }

  /** First minute at which the peak/off-peak band flips, searching 10 days ahead. */
  function nextTransition(ms) {
    const current = isPeak(ms);
    let t = Math.floor(ms / 60_000) * 60_000 + 60_000;
    for (let i = 0; i < 60 * 24 * 10; i += 1, t += 60_000) {
      if (isPeak(t) !== current) return { at: t, isPeak: isPeak(t) };
    }
    return null;
  }

  /** Peak mask for one local week, Monday-first, keyed by local day + hour. */
  function weekGrid(now) {
    const todayStart = clock.dayStart(now);
    const rows = [];
    for (let day = 0; day < 7; day += 1) {
      const start = clock.addDays(todayStart, day);
      const cells = [];
      for (let hour = 0; hour < 24; hour += 1) {
        const t = start + hour * 3_600_000;
        cells.push({ hour: clock.hour(t), peak: isPeak(t) });
      }
      rows.push({ date: clock.dateKey(start), weekday: clock.weekday(start), start, cells });
    }
    return rows;
  }

  return {
    isPeak,
    band,
    costOf,
    nextTransition,
    weekGrid,
    rowFor,
    pricing: config.pricing,
    schedule: { windowsUTC, weekdaysUTC, holidaysCST, excludeHolidays: excludeHolidays !== false },
    timeZone: config.displayTimeZone,
  };
}
