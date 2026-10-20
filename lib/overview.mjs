import { createClock } from './time.mjs';

const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const MAX_DAYS = 730;

function emptyBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(target, event) {
  target.input += event.input;
  target.output += event.output;
  target.cacheRead += event.cacheRead;
  target.cacheWrite += event.cacheWrite;
}

function totalTokens(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * Fold raw Session usage into the numbers the dashboard renders.
 * Everything is computed per request from the parsed Session index, so a
 * Session that is still being written keeps moving without a restart.
 */
export function buildOverview({ usage, pricing, config, balance, days, sessionId = null, now = Date.now() }) {
  const clock = createClock(config.displayTimeZone);

  const rangeDays = days == null ? null : Math.max(1, Math.min(MAX_DAYS, days));
  const todayStart = clock.dayStart(now);
  const rangeStart = rangeDays == null ? null : clock.addDays(todayStart, -(rangeDays - 1));

  // Whole-session aggregates, independent of the selected range: they feed the
  // "this session" card, which must match the session the user is working in.
  const bySession = new Map();
  for (const event of usage.events) {
    const entry = bySession.get(event.sessionId) ?? {
      tokens: emptyBuckets(),
      cost: 0,
      offPeakCost: 0,
      events: 0,
      firstTime: event.time,
      lastTime: 0,
    };
    addTokens(entry.tokens, event);
    entry.cost += pricing.costOf(event, pricing.band(event.time));
    entry.offPeakCost += pricing.costOf(event, 'offPeak');
    entry.events += 1;
    if (event.time > entry.lastTime) entry.lastTime = event.time;
    if (event.time < entry.firstTime) entry.firstTime = event.time;
    bySession.set(event.sessionId, entry);
  }

  const metaById = new Map(usage.sessions.map((session) => [session.id, session]));
  let currentId = sessionId && bySession.has(sessionId) ? sessionId : null;
  if (!currentId) {
    for (const [id, entry] of bySession) {
      if (!currentId || entry.lastTime > bySession.get(currentId).lastTime) currentId = id;
    }
  }
  const currentEntry = currentId ? bySession.get(currentId) : null;
  const currentMeta = currentId ? metaById.get(currentId) : null;
  const currentSession = currentEntry
    ? {
        id: currentId,
        title: currentMeta?.title ?? 'Phiên chưa có tiêu đề',
        model: currentMeta?.model ?? null,
        cwd: currentMeta?.cwd ?? null,
        firstTime: currentEntry.firstTime,
        lastTime: currentEntry.lastTime,
        tokens: currentEntry.tokens,
        totalTokens: totalTokens(currentEntry.tokens),
        cost: currentEntry.cost,
        savings: Math.max(0, currentEntry.cost - currentEntry.offPeakCost),
        events: currentEntry.events,
      }
    : null;

  const enriched = [];
  for (const event of usage.events) {
    if (rangeStart !== null && event.time < rangeStart) continue;
    const band = pricing.band(event.time);
    enriched.push({
      ...event,
      band,
      cost: pricing.costOf(event, band),
      offPeakCost: pricing.costOf(event, 'offPeak'),
    });
  }

  const totals = {
    tokens: emptyBuckets(),
    cost: 0,
    offPeakCost: 0,
    peakCost: 0,
    events: enriched.length,
    sessionCount: 0,
    savings: 0,
    peakShare: 0,
    cacheHitRate: 0,
    totalTokens: 0,
  };
  const seenSessions = new Set();
  for (const event of enriched) {
    addTokens(totals.tokens, event);
    totals.cost += event.cost;
    totals.offPeakCost += event.offPeakCost;
    if (event.band === 'peak') totals.peakCost += event.cost;
    seenSessions.add(event.sessionId);
  }
  totals.sessionCount = seenSessions.size;
  totals.totalTokens = totalTokens(totals.tokens);
  totals.savings = Math.max(0, totals.cost - totals.offPeakCost);
  totals.peakShare = totals.offPeakCost > 0 ? totals.cost / totals.offPeakCost - 1 : 0;
  totals.cacheHitRate =
    totals.tokens.cacheRead + totals.tokens.input + totals.tokens.cacheWrite > 0
      ? totals.tokens.cacheRead / (totals.tokens.cacheRead + totals.tokens.input + totals.tokens.cacheWrite)
      : 0;

  // Daily series -----------------------------------------------------------
  const dailyMap = new Map();
  const firstDay = rangeStart ?? (enriched.length > 0 ? clock.dayStart(enriched[0].time) : todayStart);
  const lastDay = todayStart;
  const dayCount = Math.min(MAX_DAYS, Math.max(1, Math.round((lastDay - firstDay) / clock.DAY) + 1));
  for (let i = 0; i < dayCount; i += 1) {
    const start = clock.addDays(firstDay, i);
    const key = clock.dateKey(start);
    dailyMap.set(key, {
      date: key,
      start,
      tokens: emptyBuckets(),
      peakTokens: emptyBuckets(),
      totalTokens: 0,
      cost: 0,
      peakCost: 0,
      offPeakCost: 0,
      events: 0,
    });
  }
  for (const event of enriched) {
    const key = clock.dateKey(event.time);
    const bucket = dailyMap.get(key);
    if (!bucket) continue;
    addTokens(bucket.tokens, event);
    if (event.band === 'peak') addTokens(bucket.peakTokens, event);
    bucket.totalTokens += event.input + event.output + event.cacheRead + event.cacheWrite;
    bucket.cost += event.cost;
    bucket.offPeakCost += event.offPeakCost;
    if (event.band === 'peak') bucket.peakCost += event.cost;
    bucket.events += 1;
  }
  const daily = [...dailyMap.values()];

  // Hour-of-week grid ------------------------------------------------------
  const grid = new Map();
  for (const weekday of MONDAY_FIRST) grid.set(weekday, Array.from({ length: 24 }, () => ({ tokens: 0, cost: 0, events: 0 })));
  for (const event of enriched) {
    const row = grid.get(clock.weekday(event.time));
    const cell = row?.[clock.hour(event.time)];
    if (!cell) continue;
    cell.tokens += event.input + event.output + event.cacheRead + event.cacheWrite;
    cell.cost += event.cost;
    cell.events += 1;
  }
  const hourly = MONDAY_FIRST.map((weekday) => ({ weekday, label: WEEKDAY_LABELS[weekday], cells: grid.get(weekday) }));

  // Models ----------------------------------------------------------------
  const modelMap = new Map();
  for (const event of enriched) {
    const entry = modelMap.get(event.model) ?? { model: event.model, tokens: 0, cost: 0, events: 0 };
    entry.tokens += event.input + event.output + event.cacheRead + event.cacheWrite;
    entry.cost += event.cost;
    entry.events += 1;
    modelMap.set(event.model, entry);
  }
  const models = [...modelMap.values()]
    .map((entry) => ({ ...entry, label: pricing.rowFor(entry.model)?.label ?? entry.model }))
    .sort((a, b) => b.cost - a.cost);

  // Session table ---------------------------------------------------------
  const perSession = new Map();
  for (const event of enriched) {
    const entry = perSession.get(event.sessionId) ?? { tokens: 0, cost: 0, events: 0, lastTime: 0 };
    entry.tokens += event.input + event.output + event.cacheRead + event.cacheWrite;
    entry.cost += event.cost;
    entry.events += 1;
    if (event.time > entry.lastTime) entry.lastTime = event.time;
    perSession.set(event.sessionId, entry);
  }
  const sessionMeta = new Map(usage.sessions.map((session) => [session.id, session]));
  const sessions = [...perSession.entries()]
    .map(([id, entry]) => {
      const meta = sessionMeta.get(id);
      return {
        id,
        title: meta?.title ?? 'Phiên chưa có tiêu đề',
        cwd: meta?.cwd ?? null,
        model: meta?.model ?? null,
        lastTime: entry.lastTime,
        tokens: entry.tokens,
        cost: entry.cost,
        events: entry.events,
      };
    })
    .sort((a, b) => b.lastTime - a.lastTime)
    .slice(0, 15);

  // All-time figures + burn rate -----------------------------------------
  const allTime = { tokens: emptyBuckets(), cost: 0, offPeakCost: 0, events: 0 };
  for (const event of usage.events) {
    addTokens(allTime.tokens, event);
    allTime.cost += pricing.costOf(event, pricing.band(event.time));
    allTime.offPeakCost += pricing.costOf(event, 'offPeak');
    allTime.events += 1;
  }
  allTime.totalTokens = totalTokens(allTime.tokens);

  const sevenDayStart = clock.addDays(todayStart, -6);
  let recentCost = 0;
  for (const event of enriched) {
    if (event.time < sevenDayStart) continue;
    recentCost += event.cost;
  }
  const dailyBurn = recentCost / 7;
  const runwayDays =
    balance?.connected && dailyBurn > 0 ? Math.max(0, balance.total / dailyBurn) : null;

  // Peak schedule ---------------------------------------------------------
  const isPeakNow = pricing.isPeak(now);
  const transition = pricing.nextTransition(now);
  const week = pricing.weekGrid(now);
  const offsetHours = clock.offsetMinutes(now) / 60;
  const peakWindowsLocal = pricing.schedule.windowsUTC.map((window) => ({
    start: ((window.start + offsetHours) % 24 + 24) % 24,
    end: ((window.end + offsetHours) % 24 + 24) % 24,
  }));

  // weekday -> hour peak mask, sampled in the configured display zone so the
  // heatmap guide matches local hours instead of raw UTC weekdays.
  const mask = Array.from({ length: 7 }, () => Array(24).fill(false));
  for (let weekday = 0; weekday < 7; weekday += 1) {
    let dayStart = todayStart;
    while (clock.weekday(dayStart) !== weekday) dayStart = clock.addDays(dayStart, 1);
    for (let hour = 0; hour < 24; hour += 1) {
      mask[weekday][hour] = pricing.isPeak(dayStart + hour * 3_600_000 + 1_800_000);
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    now,
    range: {
      days: rangeDays,
      start: rangeStart === null ? (enriched.length ? enriched[0].time : null) : rangeStart,
      end: now,
    },
    timezone: {
      name: clock.timeZone,
      offsetMinutes: clock.offsetMinutes(now),
    },
    pricing: {
      currency: config.pricing.currency ?? 'USD',
      unit: config.pricing.unit ?? 1_000_000,
      source: config.pricing.source ?? null,
      models: Object.entries(config.pricing.perMillion).map(([model, row]) => ({ model, ...row })),
      schedule: pricing.schedule,
      peakWindowsLocal,
    },
    peak: {
      isPeak: isPeakNow,
      nextChangeAt: transition?.at ?? null,
      nextIsPeak: transition?.isPeak ?? null,
      warnBeforeMs: (config.peakWarningMinutes ?? 15) * 60_000,
      mask,
      week: week.map((day) => ({
        date: day.date,
        weekday: day.weekday,
        label: WEEKDAY_LABELS[day.weekday],
        cells: day.cells.map((cell) => cell.peak),
      })),
    },
    balance,
    currentSession,
    totals,
    allTime,
    daily,
    hourly,
    models,
    sessions,
    burn: { dailyCost: dailyBurn, runwayDays, recentCost, windowDays: 7 },
    meta: {
      sessionFiles: usage.files,
      sessionCount: usage.sessions.length,
      trackedSessions: perSession.size,
      firstEventAt: usage.events.length ? usage.events[0].time : null,
      lastEventAt: usage.events.length ? usage.events[usage.events.length - 1].time : null,
    },
  };
}
