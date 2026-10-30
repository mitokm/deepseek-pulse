const COLORS = {
  peak: '#f5a524',
  off: '#34d399',
  accent: '#4d6bfe',
  cyan: '#22d3ee',
  violet: '#8b7bff',
  grid: 'rgba(148,163,184,0.13)',
  axis: '#5b6b86',
  text: '#e8eefb',
};

const state = { days: 14, data: null, busy: false, loadedAt: 0, error: null };

const app = document.getElementById('app');

/* ------------------------------------------------------------------ utils */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function money(value, digits) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  const abs = Math.abs(value);
  const d = digits ?? (abs < 0.001 ? 6 : abs < 1 ? 3 : 2);
  return `$${value.toFixed(d)}`;
}

function tokens(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function percent(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} ngày ${hours} giờ`;
  if (hours > 0) return `${hours} giờ ${String(minutes).padStart(2, '0')} phút`;
  if (minutes > 0) return `${minutes} phút ${String(seconds).padStart(2, '0')} giây`;
  return `${seconds} giây`;
}

let formatters = null;
function buildFormatters(tz) {
  formatters = {
    time: new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
    timeShort: new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', hour12: false }),
    dateTime: new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
    dayMonth: new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit' }),
    weekday: new Intl.DateTimeFormat('vi-VN', { timeZone: tz, weekday: 'short' }),
  };
}

const fmtTime = (ms) => (formatters ? formatters.time.format(new Date(ms)) : '—');
const fmtDayMonth = (ms) => (formatters ? formatters.dayMonth.format(new Date(ms)) : '—');
const fmtDateTime = (ms) =>
  formatters ? `${formatters.dayMonth.format(new Date(ms))} ${formatters.time.format(new Date(ms))}` : '—';
const fmtWeekday = (ms) => (formatters ? formatters.weekday.format(new Date(ms)) : '—');

const isCompact = () => window.matchMedia('(max-width: 720px)').matches;

/** Inside the Harness panel the always-on overlay owns notifications. */
const EMBEDDED = new URLSearchParams(window.location.search).has('embed');

/* ------------------------------------------------------- peak notifications */

const notifiedTransitions = new Set();

function requestNotificationPermission() {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    const request = Notification.requestPermission();
    if (request && typeof request.catch === 'function') request.catch(() => {});
  } catch {
    /* notifications unavailable */
  }
}

/** Warn once per transition when the peak window is about to start. */
function maybeNotifyPeak(data) {
  if (EMBEDDED) return;
  const peak = data?.peak;
  if (!peak?.nextChangeAt || !peak.nextIsPeak) return;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  } catch {
    return;
  }
  const msLeft = peak.nextChangeAt - Date.now();
  const warnBefore = peak.warnBeforeMs ?? 15 * 60_000;
  if (msLeft <= 0 || msLeft > warnBefore) return;
  const key = String(peak.nextChangeAt);
  if (notifiedTransitions.has(key)) return;
  notifiedTransitions.add(key);
  try {
    const minutes = Math.max(1, Math.round(msLeft / 60_000));
    new Notification('Sắp vào giờ cao điểm', {
      body: `Còn ~${minutes} phút. Từ ${fmtTime(peak.nextChangeAt)} giá token gấp đôi — nên dời việc nặng sang sau.`,
      tag: 'deepseek-pulse-peak',
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------- balance drop notifications */

const BALANCE_STEP_KEY = 'pulse.balance.step';
const BALANCE_BASE_KEY = 'pulse.balance.baseline';
const BALANCE_MIN_STEP = 0.1;
const BALANCE_DEFAULT_STEP = 1;

function clampBalanceStep(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return BALANCE_DEFAULT_STEP;
  return Math.max(BALANCE_MIN_STEP, Math.round(parsed * 100) / 100);
}

function readBalanceStep() {
  try {
    const raw = window.localStorage.getItem(BALANCE_STEP_KEY);
    return raw === null ? BALANCE_DEFAULT_STEP : clampBalanceStep(raw);
  } catch {
    return BALANCE_DEFAULT_STEP;
  }
}

function saveBalanceStep(value) {
  try {
    window.localStorage.setItem(BALANCE_STEP_KEY, String(clampBalanceStep(value)));
  } catch {
    /* storage may be unavailable */
  }
}

function readBalanceBaseline() {
  try {
    const raw = Number(window.localStorage.getItem(BALANCE_BASE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

function writeBalanceBaseline(value) {
  try {
    window.localStorage.setItem(BALANCE_BASE_KEY, String(Math.round(value * 1e6) / 1e6));
  } catch {
    /* storage may be unavailable */
  }
}

/** Fire one OS notification; returns false when notifications are not allowed. */
function fireBalanceNotification(drop, total, step) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    new Notification(`Số dư giảm $${drop.toFixed(2)}`, {
      body: `Còn $${total.toFixed(2)} · ngưỡng báo $${step.toFixed(2)}`,
      tag: 'deepseek-pulse-balance',
    });
    return true;
  } catch {
    return false;
  }
}

/** One notification per configured step the balance falls below the baseline. */
function maybeNotifyBalanceDrop(balance) {
  if (EMBEDDED) return;
  if (!balance?.connected || !Number.isFinite(balance.total)) return;
  const step = readBalanceStep();
  const baseline = readBalanceBaseline();
  if (baseline === null) {
    writeBalanceBaseline(balance.total);
    return;
  }
  const drop = baseline - balance.total;
  if (drop <= 0) {
    if (drop < -0.005) writeBalanceBaseline(balance.total); // topped up: rebase silently
    return;
  }
  if (drop < step) return;
  writeBalanceBaseline(balance.total);
  fireBalanceNotification(drop, balance.total, step);
}

/* ------------------------------------------------------------------ fetch */

/** Current email-alert status from the host; null when the endpoint is absent. */
async function fetchAlerts() {
  try {
    const response = await fetch('api/alerts', { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function load({ force = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  app.classList.add('loading');
  const button = document.querySelector('[data-action="refresh"]');
  button?.classList.add('spinning');
  if (button) button.disabled = true;

  try {
    const query = new URLSearchParams({ days: state.days === 'all' ? 'all' : String(state.days) });
    if (force) query.set('force', '1');
    // Relative to the document so the same UI works at `/` (standalone server)
    // and at `/pulse/` (mounted inside the DeepSeek Harness GUI).
    const response = await fetch(`api/overview?${query}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.error = null;
    buildFormatters(state.data.timezone.name);
    state.alerts = await fetchAlerts();
    maybeNotifyBalanceDrop(state.data.balance);
  } catch (error) {
    state.error = String(error?.message ?? error);
  } finally {
    state.busy = false;
    state.loadedAt = Date.now();
    app.classList.remove('loading');
    button?.classList.remove('spinning');
    if (button) button.disabled = false;
    render();
  }
}

/* ------------------------------------------------------------------ parts */

function iconRefresh() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
}

function renderTopbar(data) {
  const peak = data?.peak;
  const status = !data
    ? '<span class="status-pill is-offline"><span class="dot" style="background:#5b6b86"></span>Đang tải</span>'
    : peak?.isPeak
      ? '<span class="status-pill is-peak"><span class="dot"></span>Giờ cao điểm</span>'
      : '<span class="status-pill is-off"><span class="dot"></span>Giờ thấp điểm</span>';

  const ranges = [
    { value: 7, label: '7N' },
    { value: 14, label: '14N' },
    { value: 30, label: '30N' },
    { value: 'all', label: 'Tất cả' },
  ];

  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h4l2.5-7 4 14 2.5-7h5"/></svg>
        </div>
        <div>
          <div class="brand-title">DeepSeek Pulse</div>
          <div class="brand-sub">Token · giá cao điểm/thấp điểm · số dư tài khoản</div>
        </div>
      </div>
      <div class="topbar-right">
        ${status}
        <span class="clock-chip" data-live="clock">--:--:--</span>
        <div class="segmented" role="group" aria-label="Khoảng thời gian">
          ${ranges
            .map(
              (range) =>
                `<button type="button" data-days="${range.value}" aria-pressed="${String(state.days) === String(range.value)}">${range.label}</button>`,
            )
            .join('')}
        </div>
        <button type="button" class="icon-button" data-action="refresh">${iconRefresh()} Cập nhật</button>
      </div>
    </header>`;
}

function renderNotice(data) {
  if (state.error) return `<div class="notice error"><span>⚠</span><div>Không tải được dữ liệu: ${esc(state.error)}</div></div>`;
  if (data?.balance && data.balance.connected === false) {
    return `<div class="notice"><span>⚠</span><div><b>Số dư chưa đọc được.</b> ${esc(data.balance.message ?? '')}</div></div>`;
  }
  if (data?.balance?.stale) {
    return `<div class="notice"><span>↻</span><div>Số dư đang dùng bản lưu gần nhất — ${esc(data.balance.error ?? 'không gọi được Platform')}</div></div>`;
  }
  return '';
}

function renderKpis(data) {
  const t = data.totals;
  const balance = data.balance;
  const burn = data.burn;
  // `currentSession` is the exact payload from the server; until the plugin host
  // is reloaded, the newest row of the session table stands in for it (same id,
  // without the cache/input/output split).
  const current =
    data.currentSession ??
    (data.sessions?.length
      ? {
          id: data.sessions[0].id,
          title: data.sessions[0].title,
          totalTokens: data.sessions[0].tokens,
          cost: data.sessions[0].cost,
          events: data.sessions[0].events,
          tokens: null,
        }
      : null);

  // The second card tracks the session being worked in; the period totals live
  // in the tooltip so the card stays about "right now".
  const scale = current?.tokens ?? t.tokens;
  const mix = [
    { key: 'cacheRead', label: 'Cache đọc', color: COLORS.accent, value: scale.cacheRead },
    { key: 'input', label: 'Input', color: COLORS.violet, value: scale.input },
    { key: 'output', label: 'Output', color: COLORS.cyan, value: scale.output },
  ];
  const mixTotal = mix.reduce((sum, item) => sum + item.value, 0) || 1;
  const hasMix = Boolean(current?.tokens);

  const runway = balance?.connected && burn.runwayDays != null ? burn.runwayDays : null;

  const tokenCard = current
    ? `<div class="kpi" title="Toàn kỳ: ${tokens(t.totalTokens)} token · ${money(t.cost)} trên ${t.sessionCount} phiên">
        <div class="kpi-label">Token phiên này</div>
        <div class="kpi-value">${tokens(current.totalTokens)}</div>
        <div class="kpi-session" title="${esc(current.title)}">${esc(current.title)}</div>
        ${
          hasMix
            ? `<div class="meter" style="margin-top:9px" aria-hidden="true">
                 ${mix.map((item) => `<i style="width:${(item.value / mixTotal) * 100}%;background:${item.color}"></i>`).join('')}
               </div>`
            : ''
        }
        <div class="kpi-sub">
          ${
            hasMix
              ? `<span>cache đọc <b>${tokens(current.tokens.cacheRead)}</b></span>
                 <span>vào <b>${tokens(current.tokens.input)}</b></span>
                 <span>ra <b>${tokens(current.tokens.output)}</b></span>`
              : `<span><b>${current.events.toLocaleString('vi-VN')}</b> lượt gọi</span>`
          }
          <span>chi phí <b>${money(current.cost)}</b></span>
        </div>
      </div>`
    : `<div class="kpi">
        <div class="kpi-label">Token trong kỳ</div>
        <div class="kpi-value">${tokens(t.totalTokens)}</div>
        <div class="meter" style="margin-top:10px" aria-hidden="true">
          ${mix.map((item) => `<i style="width:${(item.value / mixTotal) * 100}%;background:${item.color}"></i>`).join('')}
        </div>
        <div class="kpi-sub">
          <span>cache đọc <b>${tokens(t.tokens.cacheRead)}</b></span>
          <span>vào <b>${tokens(t.tokens.input)}</b></span>
          <span>ra <b>${tokens(t.tokens.output)}</b></span>
        </div>
      </div>`;

  return `
    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-label">Chi phí trong kỳ</div>
        <div class="kpi-value">${money(t.cost)}</div>
        <div class="kpi-sub">
          <span><b>${money(burn.dailyCost)}</b>/ngày (7N)</span>
          <span><b>${t.events.toLocaleString('vi-VN')}</b> lượt gọi</span>
        </div>
      </div>
      ${tokenCard}
      <div class="kpi">
        <div class="kpi-label">Trả thêm do cao điểm</div>
        <div class="kpi-value warn">${money(t.savings)}</div>
        <div class="kpi-sub">
          <span>cao hơn mức thấp điểm <b>${percent(t.peakShare)}</b></span>
          <span>nếu toàn thấp điểm: <b>${money(t.offPeakCost)}</b></span>
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Dự báo còn dùng được</div>
        <div class="kpi-value ${runway == null ? '' : runway < 7 ? 'warn' : 'good'}">
          ${runway == null ? '—' : runway.toFixed(runway < 10 ? 1 : 0)}<span class="unit">ngày</span>
        </div>
        <div class="kpi-sub">
          <span>số dư <b>${balance?.connected ? money(balance.total, 2) : '—'}</b></span>
          <span>cache hit <b>${percent(t.cacheHitRate)}</b></span>
        </div>
      </div>
    </div>`;
}

function renderBalance(data) {
  const balance = data.balance;
  const burn = data.burn;

  if (!balance?.connected) {
    return `
      <section class="card span-4">
        <div class="card-head">
          <div>
            <div class="card-title">Số dư DeepSeek</div>
            <div class="card-hint">Đọc trực tiếp từ Platform</div>
          </div>
        </div>
        <div class="balance-total">—</div>
        <div class="mini-rows">
          <div class="mini-row"><span>Trạng thái</span><b>chưa kết nối</b></div>
          <div class="mini-row"><span>Lý do</span><b>${esc(balance?.reason ?? 'unknown')}</b></div>
        </div>
        <div class="card-hint" style="margin-top:14px">${esc(balance?.message ?? 'Đăng nhập DeepSeek trong ứng dụng để đọc số dư.')}</div>
      </section>`;
  }

  const total = balance.total || 0;
  const topped = balance.toppedUp || 0;
  const bonus = balance.bonus || 0;
  const lifetime = balance.lifetimeCost?.find((entry) => entry.currency === balance.currency)?.amount ?? null;
  const runway = burn.runwayDays;
  const today = data.daily.length ? data.daily[data.daily.length - 1] : null;
  const topModel = data.models[0]?.model;
  const priceRow =
    data.pricing.models.find((row) => row.model === topModel) ?? data.pricing.models[0] ?? null;

  // The host keeps the alert threshold in pulse-alert.json (shared with email);
  // localStorage mirrors it so the dock can notify before the next host reload.
  const serverStep = Number(state.alerts?.dropAmount);
  const step = Number.isFinite(serverStep) && serverStep > 0 ? serverStep : readBalanceStep();
  const stepValue = step.toFixed(2);

  const permission = (() => {
    try {
      return typeof Notification === 'undefined' ? 'none' : Notification.permission;
    } catch {
      return 'none';
    }
  })();
  const permissionText =
    permission === 'granted'
      ? 'thông báo bật'
      : permission === 'denied'
        ? 'đã chặn thông báo'
        : permission === 'none'
          ? 'không hỗ trợ thông báo'
          : 'chưa cấp quyền';
  const alertsHint = `${permissionText}${state.alerts?.configured ? ' · email bật' : ''}`;

  const baseline = readBalanceBaseline();
  const rawDrop = baseline === null ? 0 : baseline - total;
  const dropSoFar = Math.max(0, Math.round(rawDrop * 100) / 100);
  const remaining = Math.max(0, Math.round((step - dropSoFar) * 100) / 100);
  const progressText =
    baseline === null
      ? 'mốc sẽ đặt ở lần lấy số dư đầu tiên'
      : remaining <= 0
        ? `đã giảm ${money(dropSoFar, 2)} — báo ở lần cập nhật sau`
        : `đã giảm ${money(dropSoFar, 2)} · còn ${money(remaining, 2)} nữa để báo`;

  return `
    <section class="card span-4">
      <div class="card-head">
        <div>
          <div class="card-title">Số dư DeepSeek</div>
          <div class="card-hint">Cập nhật ${balance.fetchedAt ? fmtTime(new Date(balance.fetchedAt).getTime()) : '—'} · ${esc(balance.currency)}</div>
        </div>
        <span class="tag">${esc(balance.currency)}</span>
      </div>

      <div class="balance-total">${money(total, 2)}<span class="cur">${esc(balance.currency)}</span></div>
      <div class="meter" aria-hidden="true">
        ${total > 0 ? `<i class="topup" style="width:${(topped / total) * 100}%"></i><i class="bonus" style="width:${(bonus / total) * 100}%"></i>` : ''}
      </div>
      <div class="balance-split">
        <div><div class="label">Nạp tiền</div><div class="value">${money(topped, 2)}</div></div>
        <div><div class="label">Tặng thêm</div><div class="value">${money(bonus, 2)}</div></div>
      </div>

      <div class="mini-rows">
        <div class="mini-row"><span>Tổng chi tiêu (console)</span><b>${lifetime == null ? '—' : money(lifetime, 2)}</b></div>
        <div class="mini-row"><span>Đốt tiền 7 ngày</span><b>${money(burn.dailyCost)}/ngày</b></div>
        <div class="mini-row"><span>Còn dùng được</span><b>${runway == null ? '—' : `${runway.toFixed(1)} ngày`}</b></div>
      </div>

      <div class="mini-rows" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
        <div class="mini-row"><span>Hôm nay · token</span><b>${today ? tokens(today.totalTokens) : '—'}</b></div>
        <div class="mini-row"><span>Hôm nay · chi phí</span><b>${today ? money(today.cost) : '—'}</b></div>
        ${priceRow ? `<div class="mini-row"><span>Giá 1M ra (thấp↔cao)</span><b>$${priceRow.output.offPeak} ↔ $${priceRow.output.peak}</b></div>` : ''}
      </div>

      <div class="alert-setting">
        <div class="mini-row">
          <span>Báo khi số dư giảm</span>
          <span class="step-input">
            <input type="number" data-balance-step min="0.1" step="0.1" value="${stepValue}" aria-label="Ngưỡng báo số dư, USD" />
            <span class="unit">$</span>
          </span>
        </div>
        <div class="alert-actions">
          <button type="button" data-action="test-balance-alert">Thử thông báo</button>
          <span class="alert-hint" data-alert-hint>${esc(alertsHint)}</span>
        </div>
        <div class="alert-progress" data-alert-progress>${esc(progressText)}</div>
      </div>
    </section>`;
}

function timelineSvg(day, compact) {
  const W = compact ? 400 : 940;
  const H = compact ? 52 : 58;
  const step = W / 24;
  const labelEvery = compact ? 6 : 3;
  const bars = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const peak = day.cells[hour];
    bars.push(
      `<rect x="${hour * step}" y="10" width="${Math.max(1, step - 2)}" height="${compact ? 22 : 26}" rx="4" fill="${peak ? 'rgba(245,165,36,0.5)' : 'rgba(148,163,184,0.16)'}"/>`,
    );
  }
  const labels = [];
  for (let hour = 0; hour < 24; hour += labelEvery) {
    labels.push(
      `<text x="${hour * step + step / 2}" y="${H - 6}" text-anchor="middle" font-size="${compact ? 9 : 10}" fill="${COLORS.axis}">${String(hour).padStart(2, '0')}:00</text>`,
    );
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dải 24 giờ hôm nay">${bars.join('')}${labels.join('')}</svg>`;
}

function renderPeakClock(data, compact) {
  const peak = data.peak;
  const week = peak.week;
  const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: data.timezone.name, hour: '2-digit', hour12: false });
  const currentCell = Number(hourFormat.format(new Date()));

  const windows = data.pricing.peakWindowsLocal
    .map((window) => `${String(Math.round(window.start)).padStart(2, '0')}:00–${String(Math.round(window.end)).padStart(2, '0')}:00`)
    .join(' · ');

  const rows = week
    .map((day, index) => {
      const cells = day.cells
        .map((isPeak, hour) => {
          const cls = [isPeak ? 'peak' : '', index === 0 ? 'today' : '', index === 0 && hour === currentCell ? 'now' : '']
            .filter(Boolean)
            .join(' ');
          return `<i class="${cls}"></i>`;
        })
        .join('');
      const label = `${day.label} ${day.date.slice(8, 10)}/${day.date.slice(5, 7)}`;
      return `<div class="weekgrid-row"><div class="weekgrid-label">${esc(label)}</div><div class="weekgrid-cells">${cells}</div></div>`;
    })
    .join('');

  return `
    <section class="card span-8">
      <div class="card-head">
        <div>
          <div class="card-title">Cao điểm / thấp điểm</div>
          <div class="card-hint">Cao điểm ${esc(windows)} (giờ địa phương) · ${esc(data.timezone.name)}</div>
        </div>
        <div class="legend">
          <span><i style="background:rgba(245,165,36,0.6)"></i>Cao điểm</span>
          <span><i style="background:rgba(148,163,184,0.22)"></i>Thấp điểm</span>
        </div>
      </div>

      <div class="peak-headline">
        <div class="peak-state ${peak.isPeak ? 'is-peak' : 'is-off'}" data-live="state">${peak.isPeak ? 'Đang cao điểm' : 'Đang thấp điểm'}</div>
        <div class="peak-countdown" data-live="countdown">
          ${peak.nextChangeAt ? `chuyển sang <b>${peak.nextIsPeak ? 'cao điểm' : 'thấp điểm'}</b> sau <b>${duration(peak.nextChangeAt - Date.now())}</b>` : ''}
        </div>
      </div>

      <div class="timeline">
        ${timelineSvg(week[0], compact)}
        <div class="timeline-caption"><span>00:00</span><span>hôm nay · ${esc(data.timezone.name)}</span><span>23:59</span></div>
      </div>

      <div class="weekgrid">${rows}</div>
    </section>`;
}

/* ----------------------------------------------------------------- charts */

function renderDailyChart(data, compact) {
  const days = data.daily;
  if (!days.length) return '<section class="card"><div class="empty">Chưa có dữ liệu token trong khoảng này.</div></section>';

  const W = compact ? 400 : 940;
  const H = compact ? 232 : 300;
  const padL = compact ? 44 : 58;
  const padR = compact ? 12 : 66;
  const padT = compact ? 14 : 16;
  const padB = compact ? 30 : 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxCost = Math.max(1e-6, ...days.map((day) => day.cost));
  const maxTokens = Math.max(1, ...days.map((day) => day.totalTokens));
  const step = plotW / days.length;
  const barW = Math.max(3, Math.min(38, step * 0.56));

  const yCost = (value) => padT + plotH - (value / maxCost) * plotH;
  const yTokens = (value) => padT + plotH - (value / maxTokens) * plotH;

  const grid = [];
  const ticks = compact ? 3 : 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (maxCost * i) / ticks;
    const y = yCost(value);
    grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${COLORS.grid}" stroke-dasharray="${i === 0 ? 0 : 3}"/>`);
    grid.push(
      `<text x="${padL - 8}" y="${y + 3.5}" text-anchor="end" font-size="${compact ? 9 : 10}" fill="${COLORS.axis}">${money(value, maxCost < 10 ? 3 : 2)}</text>`,
    );
    if (!compact) {
      const tokenValue = (maxTokens * i) / ticks;
      grid.push(`<text x="${W - padR + 10}" y="${y + 3.5}" font-size="10" fill="${COLORS.axis}">${tokens(tokenValue)}</text>`);
    }
  }

  const bars = [];
  const points = [];
  days.forEach((day, index) => {
    const center = padL + step * index + step / 2;
    const offActual = Math.max(0, day.cost - day.peakCost);
    const offHeight = (offActual / maxCost) * plotH;
    const peakHeight = (day.peakCost / maxCost) * plotH;
    const x = center - barW / 2;

    bars.push(
      `<g><title>${day.date} · ${money(day.cost)} · ${tokens(day.totalTokens)} token</title>
        <rect x="${x}" y="${padT + plotH - offHeight}" width="${barW}" height="${Math.max(0.5, offHeight)}" rx="2" fill="rgba(52,211,153,0.55)"/>
        <rect x="${x}" y="${padT + plotH - offHeight - peakHeight}" width="${barW}" height="${Math.max(0, peakHeight)}" rx="2" fill="rgba(245,165,36,0.85)"/>
      </g>`,
    );
    points.push(`${center},${yTokens(day.totalTokens)}`);
  });

  const labelEvery = Math.max(1, Math.ceil(days.length / (compact ? 4 : 9)));
  const xLabels = days
    .map((day, index) =>
      index % labelEvery === 0 || index === days.length - 1
        ? `<text x="${padL + step * index + step / 2}" y="${H - 10}" text-anchor="middle" font-size="${compact ? 9 : 10}" fill="${COLORS.axis}">${esc(fmtDayMonth(new Date(day.start).getTime()))}</text>`
        : '',
    )
    .join('');

  return `
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Chi phí theo ngày &amp; token</div>
          <div class="card-hint">Cột chia theo khung giá đã dùng · đường là tổng token</div>
        </div>
        <div class="chart-legend">
          <span><i style="background:rgba(52,211,153,0.6)"></i>Thấp điểm</span>
          <span><i style="background:rgba(245,165,36,0.9)"></i>Cao điểm</span>
          <span><i style="background:${COLORS.cyan};border-radius:50%"></i>Token</span>
        </div>
      </div>
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chi phí và token theo ngày">
          ${grid.join('')}
          ${bars.join('')}
          <polyline points="${points.join(' ')}" fill="none" stroke="${COLORS.cyan}" stroke-width="1.6" stroke-opacity="0.75"/>
          ${points
            .map((point) => {
              const [x, y] = point.split(',');
              return `<circle cx="${x}" cy="${y}" r="2.2" fill="${COLORS.cyan}" fill-opacity="0.85"/>`;
            })
            .join('')}
          ${xLabels}
        </svg>
      </div>
    </section>`;
}

function renderHeatmap(data, compact) {
  const rows = data.hourly;
  if (!rows.length) return '';

  const W = compact ? 400 : 940;
  const padL = compact ? 30 : 40;
  const padT = compact ? 18 : 22;
  const cellH = compact ? 21 : 26;
  const cellW = (W - padL - 6) / 24;
  const H = padT + rows.length * cellH + (compact ? 18 : 24);
  const labelEvery = compact ? 6 : 3;

  const max = Math.max(1, ...rows.flatMap((row) => row.cells.map((cell) => cell.tokens)));

  const mask = data.peak.mask;
  const inPeakHour = (weekday, hour) => Boolean(mask?.[weekday]?.[hour]);

  const cols = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const hot = rows.some((row) => inPeakHour(row.weekday, hour));
    if (hot) {
      cols.push(
        `<rect x="${padL + hour * cellW}" y="${padT - 6}" width="${cellW - 2}" height="${rows.length * cellH + 6}" fill="rgba(245,165,36,0.07)" rx="4"/>`,
      );
    }
    const label = hour % labelEvery === 0 ? `<text x="${padL + hour * cellW + cellW / 2}" y="${padT + rows.length * cellH + 14}" text-anchor="middle" font-size="${compact ? 9 : 10}" fill="${hot ? 'rgba(245,165,36,0.85)' : COLORS.axis}">${String(hour).padStart(2, '0')}</text>` : '';
    cols.push(label);
  }

  const cells = [];
  rows.forEach((row, rowIndex) => {
    cells.push(
      `<text x="${padL - 8}" y="${padT + rowIndex * cellH + cellH / 2 + 3.5}" text-anchor="end" font-size="${compact ? 9 : 10}" fill="${COLORS.axis}">${esc(row.label)}</text>`,
    );
    row.cells.forEach((cell, hour) => {
      const intensity = Math.pow(cell.tokens / max, 0.5);
      const alpha = cell.tokens === 0 ? 0.035 : 0.1 + 0.85 * intensity;
      const peak = inPeakHour(row.weekday, hour);
      cells.push(
        `<g><title>${esc(row.label)} ${String(hour).padStart(2, '0')}:00 · ${tokens(cell.tokens)} token · ${money(cell.cost)}${peak ? ' · cao điểm' : ''}</title>
          <rect x="${padL + hour * cellW}" y="${padT + rowIndex * cellH}" width="${cellW - 2}" height="${cellH - 3}" rx="3"
            fill="rgba(77,107,254,${alpha.toFixed(3)})"${peak ? ` stroke="rgba(245,165,36,0.35)" stroke-width="1"` : ''}/>
        </g>`,
      );
    });
  });

  return `
    <section class="card span-8">
      <div class="card-head">
        <div>
          <div class="card-title">Token theo giờ trong tuần</div>
          <div class="card-hint">Vùng vàng là khung cao điểm (giá gấp đôi) · ${esc(data.timezone.name)}</div>
        </div>
      </div>
      <div class="heatmap">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mật độ token theo giờ và thứ">
          ${cols.join('')}
          ${cells.join('')}
        </svg>
      </div>
      <div class="heatmap-legend"><span>ít</span><span class="heatmap-scale"></span><span>nhiều</span></div>
    </section>`;
}

function renderSavings(data) {
  const t = data.totals;
  const balance = data.balance;
  const actual = Math.max(t.cost, 1e-9);
  const offpeak = Math.max(t.offPeakCost, 1e-9);
  const width = Math.max(actual, offpeak);

  return `
    <section class="card span-4">
      <div class="card-head">
        <div>
          <div class="card-title">Chi phí do khung giờ</div>
          <div class="card-hint">Nếu dời toàn bộ sang thấp điểm</div>
        </div>
      </div>

      <div class="savings-hero">
        <span class="amount">${money(t.savings)}</span>
        <span class="pct">trả thêm so với chạy hoàn toàn thấp điểm (${percent(t.peakShare)})</span>
      </div>

      <div class="compare-bar">
        <div class="compare-row">
          <span>Thực tế</span>
          <span class="compare-track"><i style="width:${(actual / width) * 100}%;background:linear-gradient(90deg,#f5a524,#fbbf24)"></i></span>
          <b>${money(t.cost)}</b>
        </div>
        <div class="compare-row">
          <span>Toàn thấp điểm</span>
          <span class="compare-track"><i style="width:${(offpeak / width) * 100}%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i></span>
          <b>${money(t.offPeakCost)}</b>
        </div>
      </div>

      <div class="mini-rows">
        <div class="mini-row"><span>Giá trị đã dùng (mọi phiên)</span><b>${money(data.allTime.cost)}</b></div>
        <div class="mini-row"><span>Tổng token mọi phiên</span><b>${tokens(data.allTime.totalTokens)}</b></div>
        <div class="mini-row"><span>Số dư hiện tại</span><b>${balance?.connected ? money(balance.total, 2) : '—'}</b></div>
      </div>
      <div class="card-hint" style="margin-top:12px">Chi phí là ước tính theo bảng giá công bố; số dư và "tổng chi tiêu" là số liệu thật từ Platform.</div>
    </section>`;
}

function renderSessions(data) {
  const sessions = data.sessions;
  if (!sessions.length) return '';

  const rows = sessions
    .map((session) => {
      const model = session.model ?? '—';
      const short = model.includes('pro') ? 'pro' : 'flash';
      return `<tr>
        <td>
          <div class="session-title" title="${esc(session.title)}">${esc(session.title)}</div>
          <div class="session-cwd">${esc(session.cwd ?? session.id)}</div>
        </td>
        <td class="col-model"><span class="tag ${short === 'pro' ? 'pro' : ''}">${esc(model)}</span></td>
        <td class="num">${fmtDateTime(session.lastTime)}</td>
        <td class="num">${tokens(session.tokens)}</td>
        <td class="num">${money(session.cost)}</td>
      </tr>`;
    })
    .join('');

  return `
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Phiên gần đây</div>
          <div class="card-hint">${data.meta.trackedSessions} phiên có phát sinh token trong kỳ</div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Phiên</th><th class="col-model">Model</th><th class="num">Lần cuối</th><th class="num">Token</th><th class="num">Chi phí</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function renderFooter(data) {
  const last = data.generatedAt ? fmtDateTime(new Date(data.generatedAt).getTime()) : '—';
  return `
    <div class="footnote">
      <span>Cập nhật ${esc(last)}</span>
      <span>${data.meta.sessionFiles} file phiên · ${data.meta.sessionCount} phiên</span>
      <span>Giá theo <a href="https://api-docs.deepseek.com/quick_start/pricing" target="_blank" rel="noreferrer">DeepSeek API docs</a></span>
      <span>Cao điểm: 01–04 &amp; 06–10 UTC, T2–T6 (trừ lễ TQ)</span>
    </div>`;
}

/* ----------------------------------------------------------------- render */

function render() {
  // Keep the threshold input usable while it is focused; the next render
  // (after focus leaves) shows the refreshed numbers.
  const active = document.activeElement;
  if (active && active.matches && active.matches('[data-balance-step]')) {
    state.deferredRender = true;
    return;
  }
  state.deferredRender = false;

  const data = state.data;
  const compact = isCompact();
  const body = !data
    ? `<div class="empty">${state.error ? `Không tải được dữ liệu: ${esc(state.error)}` : 'Đang tải dữ liệu…'}</div>`
    : `${renderNotice(data)}
       ${renderKpis(data)}
       <div class="layout">
         ${renderBalance(data)}
         ${renderPeakClock(data, compact)}
         ${renderDailyChart(data, compact)}
         ${renderHeatmap(data, compact)}
         ${renderSavings(data)}
         ${renderSessions(data)}
       </div>
       ${renderFooter(data)}`;

  app.innerHTML = `${renderTopbar(data)}${body}`;
  tick();
}

/* ------------------------------------------------------------------- live */

function tick() {
  if (!state.data) return;
  const now = Date.now();
  maybeNotifyPeak(state.data);

  const clock = document.querySelector('[data-live="clock"]');
  if (clock && formatters) {
    const time = formatters.time.format(new Date(now));
    const weekday = fmtWeekday(now);
    clock.textContent = `${weekday} ${time}`;
  }

  const peak = state.data.peak;
  if (peak?.nextChangeAt) {
    const countdown = document.querySelector('[data-live="countdown"]');
    if (countdown) {
      if (now >= peak.nextChangeAt) {
        if (!state.busy && now - state.loadedAt > 5000) load();
      } else {
        countdown.innerHTML = `chuyển sang <b>${peak.nextIsPeak ? 'cao điểm' : 'thấp điểm'}</b> sau <b>${duration(peak.nextChangeAt - now)}</b>`;
      }
    }
    const stateEl = document.querySelector('[data-live="state"]');
    if (stateEl) {
      const isPeak = now >= peak.nextChangeAt ? peak.nextIsPeak : peak.isPeak;
      if (isPeak !== peak.isPeak) {
        stateEl.textContent = isPeak ? 'Đang cao điểm' : 'Đang thấp điểm';
        stateEl.classList.toggle('is-peak', isPeak);
        stateEl.classList.toggle('is-off', !isPeak);
      }
    }
  }
}

/* ----------------------------------------------------------------- events */

document.addEventListener('click', (event) => {
  requestNotificationPermission();
  const range = event.target.closest('[data-days]');
  if (range) {
    const value = range.dataset.days;
    state.days = value === 'all' ? 'all' : Number(value);
    document.querySelectorAll('[data-days]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.days === String(state.days));
    });
    load();
    return;
  }
  if (event.target.closest('[data-action="refresh"]')) {
    load({ force: true });
    return;
  }
  if (event.target.closest('[data-action="test-balance-alert"]')) {
    requestNotificationPermission();
    const hint = document.querySelector('[data-alert-hint]');
    // Inside the Harness panel the corner card lives in the host page, so ask it
    // to show the sample card as well as firing the operating-system one.
    if (EMBEDDED) {
      try {
        window.parent.postMessage({ type: 'pulse:test-alert', step: readBalanceStep() }, '*');
      } catch {
        /* parent unavailable */
      }
    }
    window.setTimeout(() => {
      const step = readBalanceStep();
      const total = state.data?.balance?.total ?? 0;
      const sent = fireBalanceNotification(step, total, step);
      if (!hint) return;
      if (sent) {
        hint.textContent = 'đã gửi thử';
        hint.dataset.state = 'ok';
        return;
      }
      let permission = 'none';
      try {
        permission = typeof Notification === 'undefined' ? 'none' : Notification.permission;
      } catch {
        permission = 'none';
      }
      hint.textContent =
        permission === 'denied'
          ? 'đã chặn — bấm ổ khoá để mở'
          : permission === 'none'
            ? 'ứng dụng không hỗ trợ thông báo'
            : 'chưa cấp quyền';
      hint.dataset.state = 'warn';
    }, 600);
  }
});

document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-balance-step]');
  if (!input) return;
  const value = clampBalanceStep(input.value);
  input.value = value.toFixed(2);
  saveBalanceStep(value);

  const hint = document.querySelector('[data-alert-hint]');
  const setHint = (text, state) => {
    if (!hint) return;
    hint.textContent = text;
    hint.dataset.state = state ?? '';
  };

  try {
    const response = await fetch('api/alerts/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dropAmount: value }),
    });
    if (response.ok) {
      const payload = await response.json();
      state.alerts = { ...(state.alerts ?? {}), ...(payload.status ?? {}) };
      setHint('đã lưu · email dùng chung ngưỡng', 'ok');
    } else if (response.status === 404) {
      setHint('đã lưu cho dashboard', 'warn');
    } else {
      const payload = await response.json().catch(() => null);
      setHint(payload?.message ?? 'không lưu được', 'warn');
    }
  } catch {
    setHint('không lưu được cấu hình', 'warn');
  }
});

document.addEventListener('focusout', (event) => {
  if (!event.target.closest?.('[data-balance-step]')) return;
  if (state.deferredRender) render();
});

setInterval(tick, 1000);
setInterval(() => {
  if (!state.busy) load();
}, 60_000);

let wasCompact = isCompact();
window.addEventListener('resize', () => {
  const now = isCompact();
  if (now !== wasCompact) {
    wasCompact = now;
    render();
  }
});

load();
