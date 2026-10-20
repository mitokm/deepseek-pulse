import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULTS = {
  port: 4577,
  host: '127.0.0.1',
  displayTimeZone: 'Asia/Ho_Chi_Minh',
  defaultRangeDays: 14,
  balanceTimeoutMs: 15000,
  sessionDir: null,
};

/**
 * Load and normalize the dashboard configuration.
 * Relative paths resolve against the project root, not the process cwd.
 */
export function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const config = { ...DEFAULTS, ...raw };

  if (!config.pricing?.perMillion) throw new Error('config.pricing.perMillion is required');
  if (!Array.isArray(config.peakSchedule?.windowsUTC)) throw new Error('config.peakSchedule.windowsUTC is required');

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  config.dshHome = resolve(dshHome);
  config.sessionDir = resolve(config.sessionDir ?? join(config.dshHome, 'sessions'));
  config.credentialsFile = join(config.dshHome, '.credentials.yaml');
  config.projectRoot = resolve(file, '..');
  config.displayTimeZone = config.displayTimeZone || 'UTC';
  config.defaultRangeDays = Number(config.defaultRangeDays) || 14;

  return config;
}
