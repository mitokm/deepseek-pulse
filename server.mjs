#!/usr/bin/env node
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';
import { createPricing } from './lib/pricing.mjs';
import { createHttpApp } from './lib/http-app.mjs';
import { loadAlertConfig, updateAlertConfig } from './lib/alerts.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const config = loadConfig(join(root, 'config.json'));
const pricing = createPricing(config);
const app = createHttpApp({
  config,
  pricing,
  publicDir: join(root, 'public'),
  // The standalone entry never runs the mail watcher (the Harness host owns it);
  // it still reads and writes the shared threshold so the UI stays consistent.
  alerts: () => {
    const { config: alertConfig } = loadAlertConfig(config.dshHome);
    return {
      enabled: false,
      configured: Boolean(alertConfig?.to && alertConfig?.smtp?.host),
      dropAmount: alertConfig?.dropAmount ?? 1,
      source: 'standalone',
    };
  },
  configureAlerts: async (patch) => {
    const { config: next } = updateAlertConfig(config.dshHome, { dropAmount: patch?.dropAmount });
    return { enabled: false, configured: false, dropAmount: next.dropAmount, source: 'standalone' };
  },
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  app.handle(request, response, url);
});

function listen(port, host, attempt = 0) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 5) {
      console.warn(`[deepseek-pulse] port ${port} busy, trying ${port + 1}...`);
      listen(port + 1, host, attempt + 1);
      return;
    }
    console.error('[deepseek-pulse] cannot start:', error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log('');
    console.log('  DeepSeek Pulse');
    console.log(`  -> ${url}`);
    console.log(`  sessions: ${config.sessionDir}`);
    console.log(`  timezone: ${config.displayTimeZone}`);
    console.log('');
  });
}

listen(Number(process.env.PORT) || config.port, config.host ?? '127.0.0.1');
