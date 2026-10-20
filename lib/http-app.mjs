import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { scanSessions } from './sessions.mjs';
import { fetchBalance } from './balance.mjs';
import { buildOverview } from './overview.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function parseDays(value, fallback) {
  if (value == null || value === '' || value === 'all' || value === '0') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * One request handler shared by the standalone server and the DeepSeek Harness
 * plugin. `url` must already be stripped of the mount prefix, so both entries
 * speak the same `/api/...` and `/index.html` paths internally.
 */
export function createHttpApp({ config, pricing, publicDir }) {
  /** Balance is the only networked read, so it is cached briefly. */
  let balanceCache = { at: 0, value: null };

  async function getBalance(force) {
    if (!force && balanceCache.value && Date.now() - balanceCache.at < 60_000) return balanceCache.value;
    let value;
    try {
      value = await fetchBalance(config);
    } catch (error) {
      value = { connected: false, reason: 'error', message: String(error?.message ?? error) };
    }
    if (!value.connected && balanceCache.value?.connected) {
      value = { ...balanceCache.value, stale: true, error: value.message };
    } else {
      balanceCache.value = value;
      balanceCache.at = Date.now();
    }
    return value;
  }

  async function serveStatic(request, response, pathname) {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const target = resolve(join(publicDir, relative === '' ? 'index.html' : relative));
    if (!target.startsWith(publicDir + sep) && target !== publicDir) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (!existsSync(target)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    response.end(body);
  }

  async function handle(request, response, url) {
    try {
      if (url.pathname === '/api/overview') {
        const usage = scanSessions(config);
        const balance = await getBalance(url.searchParams.get('force') === '1');
        const days = parseDays(url.searchParams.get('days'), config.defaultRangeDays);
        const sessionId = url.searchParams.get('session') || null;
        sendJson(response, 200, buildOverview({ usage, pricing, config, balance, days, sessionId }));
        return;
      }

      if (url.pathname === '/api/peak') {
        const now = Date.now();
        const transition = pricing.nextTransition(now);
        sendJson(response, 200, {
          now,
          isPeak: pricing.isPeak(now),
          nextChangeAt: transition?.at ?? null,
          nextIsPeak: transition?.isPeak ?? null,
          warnBeforeMs: (config.peakWarningMinutes ?? 15) * 60_000,
          timeZone: config.displayTimeZone,
        });
        return;
      }

      if (url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, up: true, uptimeSec: Math.round(process.uptime()) });
        return;
      }

      if (url.pathname === '/api/balance') {
        sendJson(response, 200, await getBalance(true));
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      await serveStatic(request, response, url.pathname);
    } catch (error) {
      console.error('[deepseek-pulse]', error);
      sendJson(response, 500, { error: 'internal', message: String(error?.message ?? error) });
    }
  }

  return { handle, getBalance };
}
