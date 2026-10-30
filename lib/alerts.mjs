import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sendMail as defaultSendMail } from './mailer.mjs';

/**
 * Balance-drop alert.
 *
 * Watches the DeepSeek balance and sends one email each time it has dropped by
 * `dropAmount` (default: $1) since the last notified balance. A top-up simply
 * moves the baseline up, so the next alert waits for another full drop.
 *
 * Config lives outside the repo: `<dsh home>/pulse-alert.json`
 * State (baseline + last email) lives next to it in `pulse-alert-state.json`,
 * so restarting Harness never re-sends the same alert.
 */

const DEFAULTS = {
  enabled: true,
  dropAmount: 1,
  checkMinutes: 5,
  to: '',
  smtp: null,
};

const FILE = 'pulse-alert.json';
const STATE_FILE = 'pulse-alert-state.json';

function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadAlertConfig(dshHome) {
  const file = join(dshHome, FILE);
  if (!existsSync(file)) return { file, config: null };
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return { file, config: null, error: 'pulse-alert.json is not valid JSON' };
  const config = { ...DEFAULTS, ...raw };
  config.dropAmount = Number(config.dropAmount) || DEFAULTS.dropAmount;
  config.checkMinutes = Math.max(1, Number(config.checkMinutes) || DEFAULTS.checkMinutes);
  config.from = config.from || config.smtp?.user || '';
  return { file, config };
}

export function createBalanceAlerts({ dshHome, config, getBalance, mail = defaultSendMail, logger = console, now = () => Date.now() }) {
  const stateFile = join(dshHome, STATE_FILE);
  const state = readJson(stateFile) ?? {};
  const status = {
    enabled: Boolean(config?.enabled && config?.to && config?.smtp?.host),
    configured: Boolean(config?.to && config?.smtp?.host),
    dropAmount: config?.dropAmount ?? DEFAULTS.dropAmount,
    baseline: state.baseline ?? null,
    lastBalance: state.lastBalance ?? null,
    lastCheckAt: state.lastCheckAt ?? null,
    lastEmailAt: state.lastEmailAt ?? null,
    lastResult: null,
  };

  function save(patch) {
    Object.assign(state, patch);
    try {
      writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      logger.warn?.(`[deepseek-pulse] cannot write ${STATE_FILE}: ${error.message}`);
    }
  }

  function formatUsd(value) {
    return `$${Number(value).toFixed(2)}`;
  }

  async function check() {
    status.lastCheckAt = now();
    let balance;
    try {
      balance = await getBalance();
    } catch (error) {
      status.lastResult = `balance error: ${error.message}`;
      return { action: 'error', error: error.message };
    }
    if (!balance?.connected) {
      status.lastResult = 'balance unavailable';
      return { action: 'unavailable', reason: balance?.reason ?? 'not-connected' };
    }

    const total = Number(balance.total);
    if (!Number.isFinite(total)) {
      status.lastResult = 'balance is not a number';
      return { action: 'error', error: 'balance is not a number' };
    }
    status.lastBalance = total;

    if (state.baseline == null) {
      save({ baseline: total, lastBalance: total, lastCheckAt: status.lastCheckAt });
      status.baseline = total;
      status.lastResult = 'baseline initialised';
      return { action: 'baseline', balance: total };
    }

    if (total > Number(state.baseline) + 1e-9) {
      save({ baseline: total, lastBalance: total, lastCheckAt: status.lastCheckAt });
      status.baseline = total;
      status.lastResult = `top-up detected (${formatUsd(total)})`;
      return { action: 'topup', balance: total };
    }

    const drop = Number(state.baseline) - total;
    if (drop + 1e-9 < status.dropAmount) {
      save({ lastBalance: total, lastCheckAt: status.lastCheckAt });
      status.lastResult = `drop ${formatUsd(drop)} (below threshold)`;
      return { action: 'none', drop };
    }

    const before = Number(state.baseline);
    const subject = `DeepSeek Pulse: số dư giảm ${formatUsd(drop)} → còn ${formatUsd(total)}`;
    const text = [
      'Số dư DeepSeek vừa giảm.',
      '',
      `Trước:   ${formatUsd(before)}`,
      `Sau:     ${formatUsd(total)}`,
      `Giảm:    ${formatUsd(drop)}`,
      `Thời điểm: ${new Date(status.lastCheckAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
      '',
      'Ngưỡng cảnh báo: mỗi lần giảm ' + formatUsd(status.dropAmount) + ' (cấu hình trong ~/.dsh/pulse-alert.json).',
      '',
      'DeepSeek Pulse',
    ].join('\n');

    try {
      await mail({ smtp: config.smtp, from: config.from, to: config.to, subject, text });
    } catch (error) {
      status.lastResult = `email failed: ${error.message}`;
      logger.warn?.(`[deepseek-pulse] email failed: ${error.message}`);
      return { action: 'error', error: error.message };
    }

    save({
      baseline: total,
      lastBalance: total,
      lastCheckAt: status.lastCheckAt,
      lastEmailAt: status.lastCheckAt,
      lastEmailDrop: drop,
    });
    status.baseline = total;
    status.lastEmailAt = status.lastCheckAt;
    status.lastResult = `emailed (${formatUsd(drop)})`;
    return { action: 'emailed', drop, balance: total };
  }

  return { check, status, stateFile };
}

export function startBalanceAlerts({ dshHome, getBalance, mail, logger = console }) {
  const { config, file, error } = loadAlertConfig(dshHome);
  if (!config) {
    return { enabled: false, reason: error ?? `no ${FILE} in ${dshHome}`, file };
  }
  if (!config.enabled) return { enabled: false, reason: 'disabled in config', file };
  const missing = [];
  if (!config.to) missing.push('"to"');
  if (!config.smtp?.host) missing.push('"smtp.host"');
  if (config.smtp?.user && !config.smtp?.pass) missing.push('"smtp.pass"');
  if (missing.length) {
    return { enabled: false, reason: `${FILE} needs ${missing.join(', ')}`, file };
  }

  const watcher = createBalanceAlerts({ dshHome, config, getBalance, mail, logger });
  const everyMs = config.checkMinutes * 60_000;

  const tick = () => {
    watcher.check().catch((error) => logger.warn?.(`[deepseek-pulse] alert check failed: ${error.message}`));
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  // First check shortly after start so a restart does not wait a full interval.
  const first = setTimeout(tick, 20_000);
  first.unref?.();

  return {
    enabled: true,
    file,
    watcher,
    status: watcher.status,
    check: watcher.check,
    stop() {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
