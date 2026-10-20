import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * DeepSeek Harness persists every Session as `session.vN.jsonl.zstd`: a series
 * of independently compressed zstd frames, one per append batch. Node can
 * decode a single frame, so the reader splits on the zstd magic number and
 * inflates each frame separately.
 */

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/;

/** file path -> { stamp, meta, events } */
const parseCache = new Map();

export function assertZstdSupport() {
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error(
      'Node.js này không có zlib zstd (cần Node >= 24). Chạy bằng node đi kèm DSH: ' +
        'resources\\runtime\\primary-runtime\\node\\node.exe server.mjs',
    );
  }
}

/** Inflate every zstd frame in `buffer` and concatenate the decoded text. */
export function decodeFrames(buffer) {
  const starts = [];
  let index = 0;
  while ((index = buffer.indexOf(FRAME_MAGIC, index)) !== -1) {
    starts.push(index);
    index += FRAME_MAGIC.length;
  }
  if (starts.length === 0) return '';

  const chunks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length;
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8'));
    } catch {
      // A magic-number false positive inside compressed data: skip that slice.
    }
  }
  return chunks.join('');
}

function parseSession(file, sessionId, fallbackTime) {
  let text;
  try {
    text = decodeFrames(readFileSync(file));
  } catch {
    return null;
  }

  const meta = {
    id: sessionId,
    title: null,
    cwd: null,
    createdAt: fallbackTime,
    lastTime: fallbackTime,
    model: null,
  };
  const events = [];
  let model = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;

    switch (record.type) {
      case 'session': {
        meta.id = record.id ?? meta.id;
        meta.cwd = record.cwd ?? meta.cwd;
        meta.createdAt = record.createdAt ?? meta.createdAt;
        break;
      }
      case 'session/title': {
        const title = record.data?.title;
        if (typeof title === 'string' && title.trim()) meta.title = title.trim();
        break;
      }
      case 'request/header': {
        const next = record.data?.header?.config?.model;
        if (typeof next === 'string' && next) {
          model = next;
          meta.model = next;
        }
        break;
      }
      case 'assistant/message': {
        const usage = record.data?.usage;
        if (!usage) break;
        const input = Number(usage.inputTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        const cacheRead = Number(usage.cacheReadTokens) || 0;
        const cacheWrite = Number(usage.cacheWriteTokens) || 0;
        if (input + output + cacheRead + cacheWrite === 0) break;
        const time = Number(record.time) || meta.lastTime;
        events.push({
          time,
          sessionId: meta.id,
          model: record.data?.model ?? model ?? 'unknown',
          input,
          output,
          cacheRead,
          cacheWrite,
        });
        if (time > meta.lastTime) meta.lastTime = time;
        break;
      }
      default:
        break;
    }
  }

  return { meta, events };
}

/**
 * Read every Session log under `sessionDir`, reusing parsed results for files
 * whose mtime and size did not change.
 */
export function scanSessions(config) {
  assertZstdSupport();

  const sessions = [];
  const events = [];
  const seen = new Set();

  if (!existsSync(config.sessionDir)) {
    return { sessions, events, files: 0, scannedAt: Date.now() };
  }

  for (const workspace of readdirSync(config.sessionDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(config.sessionDir, workspace.name);
    let entries;
    try {
      entries = readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = join(workspaceDir, entry.name);
      let files;
      try {
        files = readdirSync(sessionDir).filter((name) => SESSION_FILE.test(name));
      } catch {
        continue;
      }

      for (const name of files) {
        const file = join(sessionDir, name);
        let stat;
        try {
          stat = statSync(file);
        } catch {
          continue;
        }
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        const cached = parseCache.get(file);
        let parsed;
        if (cached && cached.stamp === stamp) {
          parsed = cached;
        } else {
          const result = parseSession(file, entry.name, stat.birthtimeMs || stat.mtimeMs);
          if (!result) continue;
          parsed = { stamp, ...result };
          parseCache.set(file, parsed);
        }
        seen.add(file);
        sessions.push({ ...parsed.meta, file, workspace: workspace.name });
        for (const event of parsed.events) events.push(event);
      }
    }
  }

  for (const file of parseCache.keys()) if (!seen.has(file)) parseCache.delete(file);

  events.sort((a, b) => a.time - b.time);
  return { sessions, events, files: seen.size, scannedAt: Date.now() };
}
