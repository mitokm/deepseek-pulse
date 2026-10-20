/**
 * Dev-only helper: render the dashboard in headless Chrome via CDP at exact
 * viewport sizes, capture a screenshot, and report layout overflow + console errors.
 *
 *   node tools/preview.mjs [width] [height] [out.png]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const width = Number(process.argv[2] || 1440);
const height = Number(process.argv[3] || 2400);
const out = process.argv[4] || '.preview/cdp.png';
const url = process.env.PULSE_URL || 'http://127.0.0.1:4577/';

const profile = mkdtempSync(join(tmpdir(), 'pulse-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=9333',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:9333/json/version');
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('devtools endpoint never came up');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) handler(message.params);
      }
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', reject);
  });
}

try {
  await waitForDevtools();
  const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  const errors = [];
  cdp.on('Runtime.exceptionThrown', (params) => errors.push(params.exceptionDetails?.text ?? 'exception'));
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') errors.push(params.args.map((arg) => arg.value ?? arg.description).join(' '));
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  await cdp.send('Page.navigate', { url });
  await sleep(2500);

  const metrics = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      widest: [...document.querySelectorAll('body *')]
        .map(el => ({ tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''), right: Math.round(el.getBoundingClientRect().right) }))
        .filter(x => x.right > document.documentElement.clientWidth + 1)
        .slice(0, 6),
      table: (() => {
        const t = document.querySelector('table');
        if (!t) return null;
        return {
          tableWidth: Math.round(t.getBoundingClientRect().width),
          wrapWidth: Math.round(t.parentElement.getBoundingClientRect().width),
          columns: [...t.querySelectorAll('thead th')].map(th => Math.round(th.getBoundingClientRect().width))
        };
      })()
    })`,
    returnByValue: true,
  });

  const parsed = JSON.parse(metrics.result.value);
  console.log(JSON.stringify({ ...parsed, errors }, null, 2));

  // CLIP="x,y,width,height" captures one region instead of the whole page.
  const clip = process.env.CLIP
    ? Object.fromEntries(
        ['x', 'y', 'width', 'height'].map((key, index) => [key, Number(process.env.CLIP.split(',')[index])]),
      )
    : null;
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: Boolean(clip) || true,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${out}`);
} finally {
  chrome.kill();
}
