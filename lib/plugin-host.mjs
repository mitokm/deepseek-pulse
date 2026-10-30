import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { createPricing } from './pricing.mjs';
import { createHttpApp } from './http-app.mjs';
import { startBalanceAlerts } from './alerts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PATH = '/pulse';

/**
 * Host half of the DeepSeek Harness plugin.
 *
 * It mounts the same dashboard the standalone entry serves under `/pulse` on
 * the Harness web server, so the browser panel can load it same-origin (no
 * second port, no extra process) and the peak-alert overlay can poll
 * `/pulse/api/peak`.
 */
export default {
  name: 'deepseek-pulse',
  inject: ['webServer'],

  apply(ctx, pluginConfig = {}) {
    const config = loadConfig(join(root, 'config.json'));
    if (pluginConfig.displayTimeZone) config.displayTimeZone = pluginConfig.displayTimeZone;
    if (pluginConfig.defaultRangeDays) config.defaultRangeDays = Number(pluginConfig.defaultRangeDays) || config.defaultRangeDays;
    if (pluginConfig.sessionDir) config.sessionDir = resolve(pluginConfig.sessionDir);
    config.peakWarningMinutes = Number(pluginConfig.peakWarningMinutes) || 15;

    const pricing = createPricing(config);
    const runtime = { alerts: null };
    const app = createHttpApp({
      config,
      pricing,
      publicDir: join(root, 'public'),
      alerts: () => runtime.alerts?.status ?? { enabled: false, configured: false },
      checkAlerts: () => runtime.alerts?.check(),
    });

    // Balance watcher: reads <dsh home>/pulse-alert.json and only runs when the
    // user configured an SMTP target. It never blocks startup or the server.
    runtime.alerts = startBalanceAlerts({
      dshHome: config.dshHome,
      getBalance: () => app.getBalance(true),
      logger: ctx.logger ?? console,
    });
    ctx.on?.('dispose', () => runtime.alerts?.stop?.());

    return ctx.webServer.register({
      kind: 'prefix',
      path: BASE_PATH,
      handler(request, response) {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === BASE_PATH) {
          response.writeHead(302, { location: `${BASE_PATH}/${url.search}` });
          response.end();
          return;
        }
        const inner = new URL(`${url.pathname.slice(BASE_PATH.length) || '/'}${url.search}`, 'http://127.0.0.1');
        return app.handle(request, response, inner);
      },
    });
  },
};
