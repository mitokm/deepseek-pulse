import { readFileSync, existsSync } from 'node:fs';

/**
 * Balance comes from the DeepSeek Platform with the same grant DeepSeek
 * Harness already stores for the signed-in account. The token is read locally,
 * sent only to the configured Platform origin, and never returned to the
 * browser or written to a log.
 */

const DEFAULT_ORIGIN = 'https://platform.deepseek.com';
const CLIENT_HEADERS = {
  'x-client-platform': 'win32',
  'x-client-locale': 'en_US',
  'x-client-bundle-id': '',
  'x-client-version': '1.0.0',
};

function readGrant(credentialsFile) {
  if (!existsSync(credentialsFile)) return null;
  const lines = readFileSync(credentialsFile, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*["']?deepseek-account-platform\/default["']?\s*:\s*$/.test(line));
  if (start === -1) return null;

  const indent = lines[start].match(/^\s*/)[0].length;
  const grant = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '').trim();
    if (match[1] === 'token') grant.token = value;
    if (match[1] === 'issuer') grant.issuer = value;
  }
  return grant.token ? grant : null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWallets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((wallet) => ({ currency: wallet?.currency ?? 'USD', balance: numeric(wallet?.balance) }))
    .filter((wallet) => wallet.balance !== null);
}

function sumByCurrency(wallets) {
  const totals = new Map();
  for (const wallet of wallets) totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + wallet.balance);
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

export async function fetchBalance(config) {
  const grant = readGrant(config.credentialsFile);
  if (!grant) {
    return { connected: false, reason: 'not-signed-in', message: 'Chưa tìm thấy phiên đăng nhập DeepSeek trên máy này.' };
  }

  const origin = DEFAULT_ORIGIN;
  if (grant.issuer && grant.issuer !== origin) {
    return {
      connected: false,
      reason: 'issuer-mismatch',
      message: `Phiên đăng nhập được cấp bởi ${grant.issuer}, không phải ${origin}.`,
    };
  }

  let response;
  try {
    response = await fetch(`${origin}/api/v0/users/get_user_summary`, {
      method: 'GET',
      headers: { ...CLIENT_HEADERS, 'x-dsh-auth-token': grant.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.balanceTimeoutMs ?? 15_000),
    });
  } catch (error) {
    return { connected: false, reason: 'network', message: `Không gọi được DeepSeek Platform: ${error?.message ?? error}` };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 401 || body?.code === 40003 || body?.data?.biz_code === 40003) {
    return {
      connected: false,
      reason: 'session-expired',
      message: 'Phiên đăng nhập DeepSeek đã hết hiệu lực — hãy đăng nhập lại trong DeepSeek Harness.',
    };
  }
  if (!response.ok || !body || body.code !== 0) {
    return {
      connected: false,
      reason: 'http',
      message: `Platform trả về HTTP ${response.status}${body?.msg ? ` — ${body.msg}` : ''}.`,
    };
  }

  const data = body.data?.biz_data ?? {};
  const toppedUp = normalizeWallets(data.normal_wallets);
  const bonus = normalizeWallets(data.bonus_wallets);
  const toppedUpTotal = sumByCurrency(toppedUp);
  const bonusTotal = sumByCurrency(bonus);
  const total = new Map(toppedUpTotal.map((entry) => [entry.currency, entry.amount]));
  for (const entry of bonusTotal) total.set(entry.currency, (total.get(entry.currency) ?? 0) + entry.amount);

  const main = [...total].sort((a, b) => b[1] - a[1])[0];

  return {
    connected: true,
    fetchedAt: new Date().toISOString(),
    currency: main?.[0] ?? 'USD',
    total: main?.[1] ?? 0,
    toppedUp: toppedUpTotal[0]?.amount ?? 0,
    bonus: bonusTotal[0]?.amount ?? 0,
    toppedUpWallets: toppedUpTotal,
    bonusWallets: bonusTotal,
    lifetimeCost: Array.isArray(data.total_costs)
      ? data.total_costs
          .map((entry) => ({ currency: entry?.currency ?? 'USD', amount: numeric(entry?.amount) }))
          .filter((entry) => entry.amount !== null)
      : [],
  };
}
