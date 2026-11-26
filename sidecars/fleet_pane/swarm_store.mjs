/**
 * Antigravity native swarm & transcript store for Fleet sidecar.
 *
 * Designed for low Peak RSS and high polling throughput on 50k+ transcript lines:
 * - Streams JSONL in bounded 64 KB chunks via openSync/readSync + StringDecoder.
 * - Extracts cumulative token/step telemetry with zero-alloc scalar scanning across
 *   older lines and parses JSON objects ONLY for the 32-line sliding tail window.
 * - Does not retain full parsed board message graphs in long-lived JS heap caches.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALL,
  MAIN,
  activeAt,
  channelMentions,
  channelOf,
  channelRegistry,
  channelsAt,
  controlOf,
  createMentionsMatcher,
  currentChannels,
  effectiveChannels,
  visibleUnread,
} from './channels.mjs';

export const ID_RE = /^[a-z0-9._-]{3,128}$/i;
const VIEW_MAX_BYTES = 128 * 1024;
const STUCK_MS = 10 * 60 * 1000;
const STEP_ERROR_SETTLE_MS = 60 * 1000;
const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;
const NARRATOR_RE = /^narrator(?:-(\d+))?$/;
const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
const SHOT_RE = /^\s*(?:[-*]\s*)?screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*(.+?))?\s*$/gim;
const MAX_POSTED_FRAMES = 24;
const FRAME_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const SWARM_SCAN_TTL_MS = 2000;
const CHUNK_BYTES = 32 * 1024;
const SHARED_CHUNK_BUF = Buffer.allocUnsafe(CHUNK_BYTES);
const TAIL_CAP = 16;
const RECENT_TOOLS_CAP = 5;

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function statOf(path) {
  try {
    const s = statSync(path);
    return { ino: s.ino, mtime: s.mtimeMs, size: s.size };
  } catch {
    return { ino: 0, mtime: 0, size: -1 };
  }
}

function lruSet(cache, key, val, limit) {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, val);
}

function readSmallCached(path, cache, maxBytes = VIEW_MAX_BYTES) {
  const s = statOf(path);
  if (s.size < 0) {
    cache.delete(path);
    return { text: null, ...s };
  }
  if (s.size > maxBytes) return { text: null, tooLarge: true, ...s };
  const key = `${s.ino}:${s.mtime}:${s.size}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return { text: hit.text, ...s };
  let text = null;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { text: null, ...s };
  }
  lruSet(cache, path, { key, text }, 12);
  return { text, ...s };
}

const B_STEP_INDEX = Buffer.from('"step_index":');
const B_CREATED_AT = Buffer.from('"created_at":');
const B_PLANNER = Buffer.from('"PLANNER_RESPONSE"');
const B_MODEL = Buffer.from('"model":');
const B_USAGE = Buffer.from('"usage":');
const B_INPUT_TOK = Buffer.from('"input_tokens":');
const B_INPUT_CAMEL = Buffer.from('"inputTokens":');
const B_CACHE_SNAKE = Buffer.from('"cache_read_tokens":');
const B_CACHE_CAMEL = Buffer.from('"cacheReadTokens":');
const B_OUTPUT_TOK = Buffer.from('"output_tokens":');
const B_OUTPUT_CAMEL = Buffer.from('"outputTokens":');

function extractIntSpan(buf, start, end, keyBuf) {
  const idx = buf.indexOf(keyBuf, start);
  if (idx < 0 || idx >= end) return -1;
  let pos = idx + keyBuf.length;
  while (pos < end && (buf[pos] === 32 || buf[pos] === 9)) pos++;
  let val = 0;
  let digits = 0;
  while (pos < end) {
    const c = buf[pos];
    if (c < 48 || c > 57) break;
    val = val * 10 + (c - 48);
    digits++;
    pos++;
  }
  return digits > 0 ? val : -1;
}

function extractStrSpan(buf, start, end, keyBuf) {
  const idx = buf.indexOf(keyBuf, start);
  if (idx < 0 || idx >= end) return '';
  let pos = idx + keyBuf.length;
  while (pos < end && (buf[pos] === 32 || buf[pos] === 9)) pos++;
  if (pos >= end || buf[pos] !== 34) return '';
  const qStart = pos + 1;
  const qEnd = buf.indexOf(34, qStart);
  if (qEnd < 0 || qEnd >= end) return '';
  const bs = buf.indexOf(92, qStart);
  if (bs >= 0 && bs < qEnd) return '';
  return buf.toString('utf8', qStart, qEnd);
}

/**
 * Incrementally stream lines from a growing JSONL file using bounded 64 KB chunks.
 * Passes raw `(buf, start, end)` spans so history lines scan with zero JS string allocations.
 */
function streamLinesIncremental(filePath, prevMeta, onReset, onLine, { rawSpan = false } = {}) {
  const s = statOf(filePath);
  if (s.size < 0) return { exists: false, meta: null, changed: Boolean(prevMeta) };

  if (prevMeta && prevMeta.ino === s.ino && prevMeta.size === s.size && prevMeta.mtime === s.mtime) {
    return { exists: true, meta: prevMeta, changed: false };
  }

  const isAppend = Boolean(prevMeta && prevMeta.ino === s.ino && s.size >= prevMeta.size);
  let offset = isAppend ? prevMeta.size : 0;
  let carryBuf = isAppend && prevMeta.carryBuf ? prevMeta.carryBuf : Buffer.alloc(0);
  if (!isAppend) onReset();

  if (s.size > offset) {
    const fd = openSync(filePath, 'r');
    try {
      let overflowCarry = carryBuf;
      let sharedCarryLen = 0;
      if (!overflowCarry.length) {
        sharedCarryLen = 0;
      } else if (overflowCarry.length < CHUNK_BYTES) {
        overflowCarry.copy(SHARED_CHUNK_BUF, 0);
        sharedCarryLen = overflowCarry.length;
        overflowCarry = Buffer.alloc(0);
      }
      while (offset < s.size) {
        let activeBuf;
        let totalLen;
        if (overflowCarry.length) {
          const toRead = Math.min(CHUNK_BYTES, s.size - offset);
          const bytesRead = readSync(fd, SHARED_CHUNK_BUF, 0, toRead, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          activeBuf = Buffer.concat([overflowCarry, SHARED_CHUNK_BUF.subarray(0, bytesRead)]);
          totalLen = activeBuf.length;
        } else {
          const toRead = Math.min(CHUNK_BYTES - sharedCarryLen, s.size - offset);
          const bytesRead = readSync(fd, SHARED_CHUNK_BUF, sharedCarryLen, toRead, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          activeBuf = SHARED_CHUNK_BUF;
          totalLen = sharedCarryLen + bytesRead;
        }

        let pos = 0;
        for (let nl = activeBuf.indexOf(0x0a, pos); nl >= 0 && nl < totalLen; nl = activeBuf.indexOf(0x0a, pos)) {
          let start = pos;
          let end = nl;
          if (end > start && activeBuf[end - 1] === 0x0d) end--;
          while (start < end && activeBuf[start] <= 32) start++;
          while (end > start && activeBuf[end - 1] <= 32) end--;
          if (end > start) {
            const rem = Math.max(0, s.size - offset + (totalLen - nl - 1));
            if (rawSpan) onLine(activeBuf, start, end, null, rem);
            else onLine(activeBuf.toString('utf8', start, end));
          }
          pos = nl + 1;
        }
        const remLen = totalLen - pos;
        if (remLen <= 0) {
          sharedCarryLen = 0;
          overflowCarry = Buffer.alloc(0);
        } else if (remLen < CHUNK_BYTES) {
          activeBuf.copy(SHARED_CHUNK_BUF, 0, pos, totalLen);
          sharedCarryLen = remLen;
          overflowCarry = Buffer.alloc(0);
        } else {
          sharedCarryLen = 0;
          overflowCarry = Buffer.from(activeBuf.subarray(pos, totalLen));
        }
      }
      carryBuf = sharedCarryLen > 0 ? Buffer.from(SHARED_CHUNK_BUF.subarray(0, sharedCarryLen)) : overflowCarry;
    } finally {
      closeSync(fd);
    }
  }

  if (carryBuf.length) {
    const trimmedCarry = carryBuf.toString('utf8').trim();
    if (trimmedCarry) {
      try {
        const obj = JSON.parse(trimmedCarry);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          if (rawSpan) onLine(carryBuf, 0, carryBuf.length, obj, 0);
          else onLine(trimmedCarry, obj);
          carryBuf = Buffer.alloc(0);
        }
      } catch {
        // Torn trailing line kept in `carryBuf` until next write completes it.
      }
    } else {
      carryBuf = Buffer.alloc(0);
    }
  }

  return {
    exists: true,
    changed: true,
    meta: { ino: s.ino, size: s.size, mtime: s.mtime, carryBuf },
  };
}

function streamAllJsonLines(filePath) {
  const out = [];
  streamLinesIncremental(
    filePath,
    null,
    () => {},
    (line, preParsed) => {
      if (preParsed) {
        out.push(preParsed);
        return;
      }
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj);
      } catch {
        // ignore torn line
      }
    },
  );
  return out;
}

/** Parse a JSONL string (used by tests or explicit callers). */
export function parseBoard(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object' && !Array.isArray(m)) out.push(m);
    } catch {
      // ignore torn line
    }
  }
  return out;
}

function extractIntField(line, key) {
  const idx = line.indexOf(key);
  if (idx < 0) return -1;
  let pos = idx + key.length;
  while (pos < line.length && (line.charCodeAt(pos) === 32 || line.charCodeAt(pos) === 9)) pos++;
  let end = pos;
  while (end < line.length) {
    const c = line.charCodeAt(end);
    if (c < 48 || c > 57) break;
    end++;
  }
  if (end === pos) return -1;
  return Number(line.slice(pos, end));
}

function extractStringField(line, key) {
  const idx = line.indexOf(key);
  if (idx < 0) return '';
  let pos = idx + key.length;
  while (pos < line.length && (line.charCodeAt(pos) === 32 || line.charCodeAt(pos) === 9)) pos++;
  if (line.charCodeAt(pos) !== 34) return '';
  const end = line.indexOf('"', pos + 1);
  if (end < 0 || line.slice(pos + 1, end).includes('\\')) return '';
  return line.slice(pos + 1, end);
}

/** Locate Antigravity appData roots containing `brain/`. */
export function findAppDataDirs(overrideAppDataDir = '') {
  if (overrideAppDataDir) {
    return existsSync(join(overrideAppDataDir, 'brain')) ? [overrideAppDataDir] : [];
  }
  const envOverride = process.env.FLEET_APP_DATA_DIR;
  if (envOverride) {
    return existsSync(join(envOverride, 'brain')) ? [envOverride] : [];
  }
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    if (existsSync(join(dataDir, 'brain'))) return [dataDir];
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((c) => existsSync(join(c, 'brain')));
}

export const swarmDir = (appData, conv) => join(appData, 'brain', conv, '.system_generated', 'swarm');
export const transcriptPath = (appData, conv) => join(appData, 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');

export function roleOf(name, m) {
  const r = typeof m?.role === 'string' ? m.role : '';
  if (r && r !== 'worker') return r;
  const match = /^(narrator|monitor)(?:-\d+)?$/.exec(String(name ?? ''));
  return match ? match[1] : r;
}

export function isRoleWorker(name, m) {
  const r = roleOf(name, m);
  return Boolean((r && r !== 'worker' && r !== 'coordinator') || ROLE_WORKER_RE.test(String(name ?? '')));
}

function narratorRank(name, m) {
  if (roleOf(name, m) !== 'narrator') return -1;
  const match = NARRATOR_RE.exec(name) || /-(\d+)$/.exec(name);
  return match?.[1] ? Number(match[1]) : 1;
}

function pickNarrator(roster) {
  let live = null;
  let dead = null;
  for (const [name, m] of Object.entries(roster?.members || {})) {
    if (!m || typeof m !== 'object') continue;
    const rank = narratorRank(name, m);
    if (rank < 0) continue;
    if (m.killed) {
      if (!dead || rank > dead.rank) dead = { name, rank };
    } else if (!live || rank > live.rank) {
      live = { name, rank };
    }
  }
  return (live || dead)?.name || null;
}

export function parseRoster(text) {
  try {
    const r = JSON.parse(text);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    return { title: typeof r.title === 'string' ? r.title : '', members: r.members && typeof r.members === 'object' ? r.members : {} };
  } catch {
    return null;
  }
}

const BOARD_ACTIVITY = {
  swarm_wait: 'Waiting for posts',
  read_board: 'Reading the board',
  post_message: 'Posting to the board',
};

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function oneLine(s, maxLen = 96) {
  const out = String(s || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

function describeToolCall(tc) {
  const name = tc?.name || '';
  if (!name) return '';
  if (BOARD_ACTIVITY[name]) return BOARD_ACTIVITY[name];
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquote(args.toolSummary) || unquote(args.toolAction);
  if (summary) return oneLine(summary);
  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile);
  if (filePath) {
    const verb = { read_file: 'Read', write_file: 'Write', edit_file: 'Edit' }[name];
    if (verb) return `${verb} ${basename(filePath)}`;
  }
  if (name === 'code_search' && args.Query) return oneLine(`Search ${unquote(args.Query)}`);
  if (name === 'swarm' && args.action) return oneLine(`swarm ${unquote(args.action)} ${unquote(args.name)}`);
  return name;
}

function thinkingHeading(thinking) {
  if (typeof thinking !== 'string') return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(hs[hs.length - 1][1]) : '';
}

function turnEnded(tailSteps) {
  const results = [];
  for (let i = tailSteps.length - 1; i >= 0; i--) {
    const step = tailSteps[i];
    if (!step) return false;
    if (step.type === 'GENERIC') {
      results.unshift(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const wait = calls.findIndex((c) => c?.name === 'swarm_wait');
    return wait >= 0 && results.length >= calls.length && results[wait].status === 'DONE';
  }
  return false;
}

function finalReply(tailSteps) {
  if (!tailSteps.length) return null;
  const step = tailSteps[tailSteps.length - 1];
  if (!step) return null;
  const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  return step.type === 'PLANNER_RESPONSE' && calls.length === 0 ? String(step.content || '') : null;
}

function replyQuestion(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, (_, s) => s.replace(/\?/g, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    .replace(/\*\*|__/g, '');
  const qs = plain
    .split(/\n+|(?<=[.!?])\s+/)
    .map((x) => x.replace(/^[\s>*-]+/, '').trim())
    .filter((x) => /\?$/.test(x) && x.length > 3);
  return qs.length ? oneLine(qs[qs.length - 1], 200) : '';
}

const transcriptCache = new Map();
const NO_TRANSCRIPT = { key: '-', summary: null };

function num(v) {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Incrementally scan `transcript.jsonl` with near-zero V8 allocations:
 * - Scalar fields (`input_tokens`, `cache_read_tokens`, `output_tokens`, `step_index`)
 *   are scanned directly across history without retaining JS objects.
 * - Full `JSON.parse` runs only on the newest 32 lines for `recentTools`, `thinkingHeading`,
 *   `activity`, `turnEnded`, `finalReply`, and `lastContextTokens`.
 */
export function summarizeTranscript(appData, conv) {
  if (!appData || !conv || !ID_RE.test(conv)) return NO_TRANSCRIPT;
  const path = transcriptPath(appData, conv);
  let state = transcriptCache.get(path);
  if (!state) {
    state = { meta: null, acc: null, result: NO_TRANSCRIPT };
  }

  const initAcc = () => ({
    lineCount: 0,
    maxStepIndex: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    lastContextTokens: 0,
    model: '',
    startedAt: '',
    lastStepAt: '',
    rawTail: [],
    tailSteps: [],
    recentTools: [],
    latestThinking: '',
    tailCursor: 0,
    parsedTailCursor: 0,
  });

  if (!state.acc) state.acc = initAcc();

  const res = streamLinesIncremental(
    path,
    state.meta,
    () => {
      state.acc = initAcc();
    },
    (buf, start, end, preParsed, remBytes) => {
      const a = state.acc;
      a.lineCount++;

      // Only retain tail line slices near EOF (prevents 50k string allocations during initial scan)
      if (remBytes <= 12 * 1024 || preParsed) {
        a.rawTail[a.tailCursor % TAIL_CAP] = buf.toString('utf8', start, end);
      }
      a.tailCursor++;

      if (preParsed) {
        if (Number.isFinite(preParsed.step_index)) a.maxStepIndex = Math.max(a.maxStepIndex, preParsed.step_index + 1);
        if (typeof preParsed.created_at === 'string' && preParsed.created_at) {
          if (!a.startedAt) a.startedAt = preParsed.created_at;
          a.lastStepAt = preParsed.created_at;
        }
        if (typeof preParsed.model === 'string' && preParsed.model) a.model = preParsed.model;
        if (preParsed.type === 'PLANNER_RESPONSE') {
          const u = preParsed.usage && typeof preParsed.usage === 'object' ? preParsed.usage : preParsed;
          const inp = num(Number(u.input_tokens));
          const cac = num(Number(u.cache_read_tokens ?? u.cacheReadTokens));
          const out = num(Number(u.output_tokens));
          a.inputTokens += inp;
          a.cacheReadTokens += cac;
          a.outputTokens += out;
          a.lastContextTokens = inp + cac;
        }
        return;
      }

      const si = extractIntSpan(buf, start, end, B_STEP_INDEX);
      if (si >= 0) a.maxStepIndex = Math.max(a.maxStepIndex, si + 1);

      if (!a.startedAt || remBytes <= 4096) {
        const ts = extractStrSpan(buf, start, end, B_CREATED_AT);
        if (ts) {
          if (!a.startedAt) a.startedAt = ts;
          a.lastStepAt = ts;
        }
      }

      const pIdx = buf.indexOf(B_PLANNER, start);
      if (pIdx >= 0 && pIdx < end) {
        if (!a.model || remBytes <= 8192) {
          const m = extractStrSpan(buf, start, end, B_MODEL);
          if (m) a.model = m;
        }

        let inp = extractIntSpan(buf, start, end, B_INPUT_TOK);
        if (inp < 0) inp = extractIntSpan(buf, start, end, B_INPUT_CAMEL);
        let cac = extractIntSpan(buf, start, end, B_CACHE_SNAKE);
        if (cac < 0) cac = extractIntSpan(buf, start, end, B_CACHE_CAMEL);
        let out = extractIntSpan(buf, start, end, B_OUTPUT_TOK);
        if (out < 0) out = extractIntSpan(buf, start, end, B_OUTPUT_CAMEL);
        if (inp < 0 && cac < 0 && out < 0 && remBytes <= 12 * 1024) {
          const uIdx = buf.indexOf(B_USAGE, start);
          if (uIdx >= 0 && uIdx < end) {
            try {
              const parsed = JSON.parse(buf.toString('utf8', start, end));
              const u = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : parsed;
              inp = num(Number(u.input_tokens ?? u.inputTokens));
              cac = num(Number(u.cache_read_tokens ?? u.cacheReadTokens));
              out = num(Number(u.output_tokens ?? u.outputTokens));
            } catch {
              // torn line skipped
            }
          }
        }
        inp = Math.max(0, inp);
        cac = Math.max(0, cac);
        out = Math.max(0, out);
        a.inputTokens += inp;
        a.cacheReadTokens += cac;
        a.outputTokens += out;
        if (inp + cac > 0 || remBytes <= 12 * 1024) a.lastContextTokens = inp + cac;
      }
    },
    { rawSpan: true },
  );

  if (!res.exists) {
    transcriptCache.delete(path);
    return NO_TRANSCRIPT;
  }
  if (!res.changed) return state.result;

  state.meta = res.meta;
  const a = state.acc;

  // Parse ONLY newly arrived lines within the 32-line tail window and release raw JSON strings
  const parseFrom = Math.max(a.parsedTailCursor, a.tailCursor - TAIL_CAP);
  for (let ti = parseFrom; ti < a.tailCursor; ti++) {
    const line = a.rawTail[ti % TAIL_CAP];
    if (typeof line !== 'string') {
      a.tailSteps[ti % TAIL_CAP] = null;
      continue;
    }
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      a.tailSteps[ti % TAIL_CAP] = null;
      continue;
    }
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      a.tailSteps[ti % TAIL_CAP] = null;
      continue;
    }
    if (typeof step.model === 'string' && step.model) a.model = step.model;
    const th = step.type === 'PLANNER_RESPONSE' ? thinkingHeading(step.thinking) : '';
    if (th) a.latestThinking = th;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const compactCalls = [];
    for (const tc of calls) {
      const summary = describeToolCall(tc);
      const name = String(tc?.name || '');
      compactCalls.push({ name, summary });
      if (step.type === 'PLANNER_RESPONSE' && summary) {
        a.recentTools.push({
          name: name || 'tool',
          summary,
          time: typeof step.created_at === 'string' ? step.created_at : '',
        });
        if (a.recentTools.length > RECENT_TOOLS_CAP) a.recentTools.shift();
      }
    }
    a.tailSteps[ti % TAIL_CAP] = {
      type: String(step.type || ''),
      status: String(step.status || ''),
      error: typeof step.error === 'string' ? oneLine(step.error, 240) : '',
      tool_calls: compactCalls,
      thinkingHeading: th,
      content: step.type === 'PLANNER_RESPONSE' && calls.length === 0 ? String(step.content || '').slice(0, 1200) : '',
    };
  }
  a.parsedTailCursor = a.tailCursor;
  a.rawTail.length = 0;

  const tailSteps = [];
  const tailCount = a.tailSteps.length;
  const tailStart = a.tailCursor >= TAIL_CAP ? a.tailCursor % TAIL_CAP : 0;
  for (let i = 0; i < tailCount; i++) {
    tailSteps.push(a.tailSteps[(tailStart + i) % tailCount]);
  }

  let activity = '';
  let activityKind = '';
  let last = null;
  for (let i = tailSteps.length - 1; i >= 0; i--) {
    const step = tailSteps[i];
    if (!step) continue;
    if (!last) last = { type: step.type, status: step.status, error: step.error };
    if (step.type === 'USER_INPUT') break;
    if (step.type !== 'PLANNER_RESPONSE') continue;
    if (step.tool_calls.some((tc) => tc?.name === 'swarm_wait')) break;
    const labeled = step.tool_calls.filter((tc) => tc?.summary).pop();
    const label = labeled ? labeled.summary : '';
    const heading = step.thinkingHeading;
    if (label) {
      activity = label;
      activityKind = 'tool';
    } else if (heading) {
      activity = heading;
      activityKind = 'thinking';
    } else {
      continue;
    }
    break;
  }

  const idle = turnEnded(tailSteps);
  const reply = finalReply(tailSteps);
  const replied = reply !== null;
  const replyAsk = replied ? replyQuestion(reply) : '';
  const totalTokens = a.inputTokens + a.cacheReadTokens + a.outputTokens;
  const key = `${res.meta.ino}:${res.meta.mtime}:${res.meta.size}:${a.lineCount}`;

  state.result = {
    key,
    summary: {
      steps: Math.max(a.lineCount, a.maxStepIndex),
      activity,
      activityKind,
      last,
      idle,
      replied,
      replyAsk,
      mtime: res.meta.mtime,
      model: a.model,
      startedAt: a.startedAt,
      lastStepAt: a.lastStepAt,
      thinkingHeading: a.latestThinking,
      recentTools: a.recentTools.slice().reverse(),
      lastContextTokens: a.lastContextTokens,
      usage: {
        inputTokens: a.inputTokens,
        cacheReadTokens: a.cacheReadTokens,
        outputTokens: a.outputTokens,
        totalTokens,
      },
    },
  };

  lruSet(transcriptCache, path, state, 24);
  return state.result;
}

function statusOf(m, tr) {
  if (m.killed) return 'killed';
  if (typeof tr?.idle === 'boolean') return tr.idle ? 'waiting' : 'working';
  if (m.wake_mode === 'mentions' || m.wake_mode === 'anything') return 'waiting';
  return 'working';
}

function boardTimeMs(t) {
  const ms = t ? Date.parse(String(t).replace(' ', 'T')) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function stepFailure(tr, now) {
  const last = tr?.last;
  if (!last) return null;
  const modelError = last.type === 'ERROR_MESSAGE';
  const settledToolError = last.status === 'ERROR' && now - (tr.mtime || 0) >= STEP_ERROR_SETTLE_MS;
  if (!modelError && !settledToolError) return null;
  const text = last.error || (modelError ? 'model error' : 'step failed');
  return { kind: QUOTA_RE.test(text) ? 'quota' : 'error', text };
}

function systemAttention(members, now) {
  const out = [];
  for (const m of members) {
    if (m.killed || m.narrator || m.roleWorker) continue;
    if (m.failure) {
      out.push({
        id: `sys-${m.name}-${m.failure.kind}`,
        kind: m.failure.kind,
        member: m.name,
        conversation_id: m.conversation_id,
        text: `${m.name}: last step failed (${m.failure.kind === 'quota' ? 'quota' : 'error'})`,
        detail: m.failure.text,
      });
    } else if (m.status === 'working' && m.transcriptMtime && now - m.transcriptMtime > STUCK_MS) {
      out.push({
        id: `sys-${m.name}-stuck`,
        kind: 'stuck',
        member: m.name,
        conversation_id: m.conversation_id,
        text: `${m.name}: no progress and not waiting on the board`,
        detail: '',
        since: m.transcriptMtime,
      });
    }
  }
  return out;
}

function postedFrames(roster, msgs) {
  const out = new Map();
  for (const m of msgs) {
    const who = roster?.members?.[m.agent];
    if (!who || who.role === 'coordinator' || isRoleWorker(m.agent, who)) continue;
    const txt = String(m.text ?? '');
    if (!/screenshot:/i.test(txt)) continue;
    for (const g of txt.matchAll(SHOT_RE)) {
      out.delete(g[1]);
      out.set(g[1], { path: g[1], seq: Number(m.seq) || 0, caption: String(g[2] || '').slice(0, 80) });
    }
  }
  return [...out.values()].slice(-MAX_POSTED_FRAMES);
}

const smallFileCache = new Map();
const viewJsonCache = new Map();
function parseViewJson(id, f) {
  if (f.size < 0) {
    viewJsonCache.delete(id);
    return { json: null, mtime: 0, error: '' };
  }
  const key = `${f.mtime}:${f.size}`;
  let c = viewJsonCache.get(id);
  if (!c || c.key !== key) {
    let parsed = null;
    let error = '';
    if (f.tooLarge) error = 'too_large';
    else {
      try {
        const v = JSON.parse(f.text ?? '');
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v;
        else error = 'invalid';
      } catch {
        error = 'invalid';
      }
    }
    c = { key, error, good: parsed ? { json: parsed, mtime: f.mtime } : c?.good || null };
    lruSet(viewJsonCache, id, c, 16);
  }
  return { json: c.good?.json || null, mtime: c.good?.mtime || 0, error: c.error };
}

function readView(appData, id, dir, narrator) {
  let vdir = dir;
  let source = 'swarm';
  let jf = readSmallCached(join(dir, 'view.json'), smallFileCache, VIEW_MAX_BYTES);
  const conv = narrator?.conversation_id;
  if (jf.size < 0 && typeof conv === 'string' && ID_RE.test(conv)) {
    const alt = join(appData, 'brain', conv, 'swarm_view');
    const altJson = readSmallCached(join(alt, 'view.json'), smallFileCache, VIEW_MAX_BYTES);
    if (altJson.size >= 0) {
      vdir = alt;
      source = 'narrator';
      jf = altJson;
    }
  }
  const { json, mtime, error } = parseViewJson(id, jf);
  return {
    etag: `${vdir}|${jf.mtime}:${jf.size}`,
    view: {
      exists: jf.size >= 0,
      dir: vdir,
      source,
      json,
      jsonMtime: mtime,
      jsonError: error,
    },
    rawJson: jf.text || '',
  };
}

function readPlan(dir) {
  const pf = readSmallCached(join(dir, 'plan.json'), smallFileCache, VIEW_MAX_BYTES);
  let plan = null;
  if (pf.size >= 0 && !pf.tooLarge) {
    try {
      const v = JSON.parse(pf.text ?? '');
      if (v && typeof v === 'object' && !Array.isArray(v)) plan = v;
    } catch {
      plan = null;
    }
  }
  return { plan, key: `${pf.mtime}:${pf.size}` };
}

/** Validate that a target file lies strictly inside `<appData>/brain/` with no traversal. */
export function canonicalFile(target, root) {
  if (!target || typeof target !== 'string' || target.length > 4096 || !isAbsolute(target)) return null;
  if (/[%\0\\]/.test(target)) return null;
  if (target.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  try {
    const real = realpathSync(target);
    return real.startsWith(root) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function allowedFilesOf(appData, json) {
  const out = {};
  if (!json) return out;
  let brainReal;
  try {
    brainReal = realpathSync(join(appData, 'brain'));
  } catch {
    return out;
  }
  const root = brainReal.endsWith(sep) ? brainReal : brainReal + sep;
  let seen = 0;
  for (const list of ['attention', 'workstreams', 'milestones', 'risks']) {
    if (!Array.isArray(json[list])) continue;
    for (const item of json[list]) {
      if (!Array.isArray(item?.actions)) continue;
      for (const a of item.actions) {
        if (a?.type !== 'file' || typeof a.target !== 'string' || Object.hasOwn(out, a.target)) continue;
        if (++seen > 64) return out;
        const real = canonicalFile(a.target, root);
        if (real) out[a.target] = pathToFileURL(real).href;
      }
    }
  }
  return out;
}

function channelAddressees(roster, names, msgs, channels) {
  if (!channels.length || !msgs.some((m) => String(m.text ?? '').includes('@#'))) return null;
  const active = activeAt(channels, msgs);
  const sets = new Map(
    names.map((n) => {
      const m = roster.members[n];
      const role = typeof m.role === 'string' ? m.role : '';
      const current = currentChannels(n, Array.isArray(m.channels) ? m.channels : null, msgs);
      return [n, channelsAt(n, current, msgs).map((set) => effectiveChannels(role, set, n))];
    }),
  );
  return (i, text) => {
    const chans = channelMentions(text).filter((c) => c !== MAIN && active[i]?.(c));
    if (!chans.length) return null;
    const members = names.filter((n) => {
      const set = sets.get(n)[i];
      return set.includes(ALL) || chans.some((c) => set.includes(c));
    });
    return { channels: chans, members };
  };
}

function triageDetail(text) {
  const cleaned = String(text || '')
    .replace(/^\s*(?:[-*]\s*)?Screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*([^\n]+?))?\s*$/gim, (_, p, cap) => {
      const label = (cap || '').trim() || basename(p);
      return `[Screenshot: ${label}]`;
    })
    .replace(/\/home\/[^/\s]+\//g, '~/');
  return oneLine(cleaned, 160);
}

function buildTriageItems({ members, messages, sysAttention }) {
  const items = [];
  const memberMap = new Map(members.map((m) => [m.name, m]));

  for (const sys of sysAttention) {
    items.push({
      id: sys.id,
      kind: sys.kind,
      severity: 'urgent',
      member: sys.member,
      conversationId: sys.conversation_id || '',
      seq: 0,
      title: sys.text,
      detail: sys.detail || 'Inspect transcript and resume or switch model.',
      suggestedPrompt:
        sys.kind === 'quota'
          ? `@${sys.member} Hit quota/rate-limit on last step. Resume or switch model and continue.`
          : `@${sys.member} Last step appears ${sys.kind}. Check diagnostics and continue.`,
      timestamp: memberMap.get(sys.member)?.transcriptMtime || 0,
    });
  }

  for (const m of members) {
    if (m.killed || !m.replyAsk) continue;
    items.push({
      id: `ask-${m.name}-${m.steps}`,
      kind: 'question',
      severity: 'attention',
      member: m.name,
      conversationId: m.conversation_id || '',
      seq: m.lastPostSeq || 0,
      title: `${m.name} asked a question`,
      detail: m.replyAsk,
      suggestedPrompt: `@${m.name} Answering your question (#${m.lastPostSeq || 0}): `,
      timestamp: m.transcriptMtime || m.lastPostTs || 0,
    });
  }

  const latestByWorker = new Map();
  let lastVerifiedSeq = 0;
  for (const msg of messages) {
    if (msg.control) continue;
    const trimmed = msg.text.trim();
    const sender = memberMap.get(msg.agent);
    const lower = trimmed.toLowerCase();
    if (lower.includes('[verified]')) {
      lastVerifiedSeq = Math.max(lastVerifiedSeq, msg.seq);
    }
    if (/\[blocked\]/i.test(trimmed)) {
      latestByWorker.set(`blocked:${msg.agent}`, msg);
    } else if (/^@\S+\s+\[done\]|\[done\]/i.test(trimmed) && sender && sender.role !== 'coordinator' && !sender.roleWorker) {
      latestByWorker.set(`done:${msg.agent}`, msg);
    }
  }

  for (const [key, msg] of latestByWorker.entries()) {
    const sender = memberMap.get(msg.agent);
    if (!sender || sender.killed) continue;
    if (key.startsWith('blocked:')) {
      items.push({
        id: `blocked-${msg.agent}-${msg.seq}`,
        kind: 'blocked',
        severity: 'urgent',
        member: msg.agent,
        conversationId: sender.conversation_id || '',
        seq: msg.seq,
        title: `${msg.agent} posted [blocked] (#${msg.seq})`,
        detail: triageDetail(msg.text),
        suggestedPrompt: `@${msg.agent} Unblock note on #${msg.seq}: `,
        timestamp: msg.ts || 0,
      });
    } else if (key.startsWith('done:') && msg.seq > lastVerifiedSeq) {
      items.push({
        id: `verify-${msg.agent}-${msg.seq}`,
        kind: 'verify',
        severity: 'verify',
        member: msg.agent,
        conversationId: sender.conversation_id || '',
        seq: msg.seq,
        title: `${msg.agent} awaits cold verification (#${msg.seq})`,
        detail: triageDetail(msg.text),
        suggestedPrompt: `@verifier Cold-verify ${msg.agent}'s #${msg.seq} deliverable and post [verified] or [blocked].`,
        timestamp: msg.ts || 0,
      });
    }
  }

  const order = { urgent: 0, attention: 1, verify: 2 };
  items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || b.timestamp - a.timestamp);
  return items;
}

// Stores ONLY compact metadata (never 2k+ message arrays or raw file strings).
const summaryMetaCache = new Map(); // `${appData}\0${id}` -> { checkedAt, membersKey, boardKey, etag, summary }
const SNAPSHOT_TRANSCRIPT_TTL_MS = 250;

/**
 * Compute lightweight snapshot fingerprint (`etag`) + stat keys using ONLY file stats
 * and incremental transcript checks, WITHOUT reading or parsing `board.jsonl`.
 */
export function computeSwarmFingerprint(appData, id) {
  const dir = swarmDir(appData, id);
  const membersFile = readSmallCached(join(dir, 'members.json'), smallFileCache, 1024 * 1024);
  if (membersFile.text == null) return null;
  const boardStat = statOf(join(dir, 'board.jsonl'));
  const membersKey = `${membersFile.ino}:${membersFile.mtime}:${membersFile.size}`;
  const boardKey = `${boardStat.ino}:${boardStat.mtime}:${boardStat.size}`;
  const roster = parseRoster(membersFile.text) || { title: '', members: {} };
  const title = roster.title || id;
  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
  const transcripts = names.map((n) => [n, summarizeTranscript(appData, roster.members[n].conversation_id)]);
  const trKeys = transcripts.map(([n, t]) => `${n}:${t.key}`).join(',');
  const narratorName = pickNarrator(roster);
  const vf = readView(appData, id, dir, narratorName ? roster.members[narratorName] : null);
  const { key: planKey } = readPlan(dir);
  const now = Date.now();
  const stuckKeys = transcripts
    .map(([, t]) => {
      const f = stepFailure(t.summary, now);
      const mt = t.summary?.mtime || 0;
      return `${f ? f.kind : ''}${mt && now - mt > STUCK_MS ? 's' : ''}`;
    })
    .join(',');
  const etag = `${membersKey}|${boardKey}|${title}|${trKeys}|${vf.etag}|${planKey}|${stuckKeys}`;
  const member = roster.members ? Object.entries(roster.members).find(([, m]) => m?.conversation_id === id)?.[0] || null : null;
  return { membersKey, boardKey, etag, member };
}

export function getSwarmMetaKeys(appData, id) {
  const dir = swarmDir(appData, id);
  const m = statOf(join(dir, 'members.json'));
  if (m.size < 0) return null;
  const b = statOf(join(dir, 'board.jsonl'));
  return {
    membersKey: `${m.ino}:${m.mtime}:${m.size}`,
    boardKey: `${b.ino}:${b.mtime}:${b.size}`,
  };
}

/** Compute release-gate handoff progression across [done] -> [verified] -> [scale-verified] / [blocked]. */
export function computeGateReadiness(messages, triage = []) {
  let doneC = 0, doneSeq = 0;
  let verC = 0, verSeq = 0;
  let scaleC = 0, scaleSeq = 0;
  let blkC = 0, blkSeq = 0;
  for (const m of messages || []) {
    if (!m || m.control || !m.text) continue;
    const seq = Number(m.seq) || 0;
    const t = m.text;
    if (/\[scale-verified\]/i.test(t)) { scaleC++; scaleSeq = Math.max(scaleSeq, seq); }
    else if (/\[verified\]/i.test(t)) { verC++; verSeq = Math.max(verSeq, seq); }
    else if (/\[done\]/i.test(t)) { doneC++; doneSeq = Math.max(doneSeq, seq); }
    if (/\[blocked\]/i.test(t)) { blkC++; blkSeq = Math.max(blkSeq, seq); }
  }
  const activeBlk = (triage || []).find((x) => (x.kind === 'blocked' || x.severity === 'urgent') && x.seq > 0);
  if (!doneC && !verC && !scaleC && !blkC && !activeBlk) return null;
  const pendingSeq = activeBlk ? activeBlk.seq
    : doneSeq > verSeq ? doneSeq
    : verSeq > scaleSeq ? verSeq
    : blkSeq > Math.max(doneSeq, verSeq, scaleSeq) ? blkSeq
    : scaleSeq || verSeq || doneSeq || 0;
  const state = activeBlk || blkSeq > Math.max(doneSeq, verSeq, scaleSeq) ? 'blocked'
    : scaleC > 0 && doneSeq <= verSeq && verSeq <= scaleSeq ? 'ready'
    : 'verifying';
  return {
    state,
    pendingSeq,
    stages: [
      { key: 'done', label: '[done]', count: doneC, seq: doneSeq },
      { key: 'verified', label: '[verified]', count: verC, seq: verSeq },
      { key: 'scale', label: '[scale-verified]', count: scaleC, seq: scaleSeq },
      { key: 'blocked', label: '[blocked]', count: blkC, seq: blkSeq },
    ],
  };
}

/** Compute per-worker token share and high-burn warning state for coordinator guardrails. */
export function computeBurnSummary(members, totalTokens = 0) {
  const total = Number(totalTokens) || 0;
  const rows = [];
  for (const m of members || []) {
    if (m.roleWorker) continue;
    const tok = Number(m.usage?.totalTokens) || 0;
    if (tok <= 0) continue;
    const sharePct = total > 0 ? Math.round((tok / total) * 100) : 0;
    const level = tok >= 400_000 || (total >= 20_000 && sharePct >= 65 && (members?.length || 0) >= 2)
      ? 'critical'
      : tok >= 150_000 || (total >= 10_000 && sharePct >= 45 && (members?.length || 0) >= 2)
        ? 'warn'
        : 'normal';
    rows.push({ name: m.name, totalTokens: tok, sharePct, level, killed: Boolean(m.killed) });
  }
  rows.sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  const topWorker = rows[0] || null;
  const highBurnCount = rows.filter((r) => r.level !== 'normal').length;
  return { totalTokens: total, topWorker, highBurnCount, workers: rows.slice(0, 6) };
}

/**
 * Build full snapshot of a swarm WITHOUT retaining large message arrays in JS heap cache.
 * Stores compact swarm summary in `summaryMetaCache` for `listSwarms()`.
 */
export function buildSwarmSnapshot(appData, id, { includeRaw = false } = {}) {
  const cacheKey = `${appData}\0${id}`;
  const now = Date.now();
  const dir = swarmDir(appData, id);
  const membersFile = readSmallCached(join(dir, 'members.json'), smallFileCache, 1024 * 1024);
  if (membersFile.text == null) {
    summaryMetaCache.delete(cacheKey);
    return null;
  }
  const boardPath = join(dir, 'board.jsonl');
  const boardStat = statOf(boardPath);
  const membersKey = `${membersFile.ino}:${membersFile.mtime}:${membersFile.size}`;
  const boardKey = `${boardStat.ino}:${boardStat.mtime}:${boardStat.size}`;

  const roster = parseRoster(membersFile.text) || { title: '', members: {} };
  const title = roster.title || id;
  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
  const transcripts = new Map(names.map((n) => [n, summarizeTranscript(appData, roster.members[n].conversation_id)]));
  const trKeys = names.map((n) => `${n}:${transcripts.get(n).key}`).join(',');
  const narratorName = pickNarrator(roster);
  const vf = readView(appData, id, dir, narratorName ? roster.members[narratorName] : null);
  const { plan, key: planKey } = readPlan(dir);
  const allowedFiles = allowedFilesOf(appData, vf.view.json);
  const failures = new Map(names.map((n) => [n, stepFailure(transcripts.get(n).summary, now)]));
  const stuckKeys = names
    .map((n) => {
      const f = failures.get(n);
      const mt = transcripts.get(n).summary?.mtime || 0;
      return `${f ? f.kind : ''}${mt && now - mt > STUCK_MS ? 's' : ''}`;
    })
    .join(',');

  const etag = `${membersKey}|${boardKey}|${title}|${trKeys}|${vf.etag}|${planKey}|${stuckKeys}`;

  const msgs = boardStat.size > 0 ? streamAllJsonLines(boardPath) : [];
  const head = msgs.length ? Number(msgs[msgs.length - 1].seq) || msgs.length : 0;
  const frames = postedFrames(roster, msgs);
  const posts = new Map();
  const edges = new Map();
  const channels = channelRegistry(msgs);
  const byChannel = channelAddressees(roster, names, msgs, channels);
  const matchMentions = createMentionsMatcher(names);

  // Transform board messages in-place so peak heap does not hold 2x 2k-object graphs
  const seen = new Set();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const seq = Number(m.seq) || 0;
    const agent = String(m.agent ?? '');
    const text = String(m.text ?? '');
    const time = m.time || '';
    const ts = boardTimeMs(time);
    const channel = channelOf(m);
    const control = controlOf(m);
    m.seq = seq;
    m.agent = agent;
    m.text = text;
    m.time = time;
    m.ts = ts;
    if (channel !== MAIN) m.channel = channel;
    if (control) {
      m.mentions = [];
      m.all = false;
      m.control = control;
      continue;
    }
    const { mentions, all } = matchMentions(text);
    const ch = byChannel ? byChannel(i, text) : null;
    const viaChannel = ch ? ch.members.filter((n) => n !== agent && !mentions.includes(n)) : [];
    let p = posts.get(agent);
    if (!p) {
      p = { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
      posts.set(agent, p);
    }
    p.posts++;
    p.lastPostSeq = seq;
    p.lastPostTime = time;
    p.lastPostTs = ts;
    if (!isRoleWorker(agent, roster.members[agent]) && (all || mentions.length || viaChannel.length)) {
      seen.clear();
      if (all) {
        for (const to of names) {
          if (to === agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
          seen.add(to);
          const key = `${agent}\0${to}`;
          let e = edges.get(key);
          if (!e) {
            e = { from: agent, to, count: 0, direct: 0, viaAll: 0 };
            edges.set(key, e);
          }
          e.count++;
          if (mentions.includes(to) || viaChannel.includes(to)) e.direct++;
          else e.viaAll++;
        }
      } else {
        for (const to of mentions) {
          if (to === agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
          seen.add(to);
          const key = `${agent}\0${to}`;
          let e = edges.get(key);
          if (!e) {
            e = { from: agent, to, count: 0, direct: 0, viaAll: 0 };
            edges.set(key, e);
          }
          e.count++;
          e.direct++;
        }
        for (const to of viaChannel) {
          if (to === agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
          seen.add(to);
          const key = `${agent}\0${to}`;
          let e = edges.get(key);
          if (!e) {
            e = { from: agent, to, count: 0, direct: 0, viaAll: 0 };
            edges.set(key, e);
          }
          e.count++;
          e.direct++;
        }
      }
    }
    m.mentions = mentions;
    m.all = all;
    if (ch?.channels.length) {
      m.channel_mentions = ch.channels;
      m.via_channel = viaChannel;
    }
  }
  const messages = msgs;

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;

  const members = names.map((name) => {
    const m = roster.members[name];
    const last = Number(m.last_read_seq) || 0;
    const tr = transcripts.get(name).summary;
    const role = roleOf(name, m);
    let unread = Math.max(0, head - last);
    let chanFields = {};
    if (channels.length) {
      const storedRole = typeof m.role === 'string' ? m.role : '';
      const current = currentChannels(name, Array.isArray(m.channels) ? m.channels : null, msgs);
      unread = visibleUnread(name, storedRole, current, msgs, last, channels);
      chanFields = { channels: effectiveChannels(storedRole, current, name).filter((c) => typeof c === 'string') };
    }
    const usage = tr?.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
    totalInputTokens += usage.inputTokens;
    totalCacheReadTokens += usage.cacheReadTokens;
    totalOutputTokens += usage.outputTokens;

    return {
      name,
      conversation_id: m.conversation_id || '',
      model: m.model || tr?.model || '',
      role,
      wake_mode: m.wake_mode || '',
      status: statusOf(m, tr),
      wait_since: Number(m.wait_since) || 0,
      last_read_seq: last,
      unread,
      killed: !!m.killed,
      steps: tr?.steps || 0,
      activity: tr?.activity || '',
      activityKind: tr?.activityKind || '',
      replied: !!tr?.replied,
      replyAsk: tr?.replyAsk || '',
      narrator: narratorRank(name, m) >= 0,
      roleWorker: isRoleWorker(name, m),
      failure: failures.get(name),
      transcriptMtime: tr?.mtime || 0,
      startedAt: tr?.startedAt || '',
      lastStepAt: tr?.lastStepAt || '',
      thinkingHeading: tr?.thinkingHeading || '',
      recentTools: tr?.recentTools || [],
      lastContextTokens: tr?.lastContextTokens || 0,
      usage,
      ...(typeof m.workspace_mode === 'string' && m.workspace_mode ? { workspace_mode: m.workspace_mode } : {}),
      ...(typeof m.workspace === 'string' && m.workspace ? { workspace: m.workspace } : {}),
      ...(posts.get(name) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null }),
      ...chanFields,
    };
  });
  members.sort(
    (a, b) => (a.role === 'coordinator' ? 0 : 1) - (b.role === 'coordinator' ? 0 : 1) || a.name.localeCompare(b.name),
  );

  const sysAttention = systemAttention(members, now);
  const triage = buildTriageItems({ members, messages, sysAttention });
  const totalTokens = totalInputTokens + totalCacheReadTokens + totalOutputTokens;
  const burnSummary = computeBurnSummary(members, totalTokens);
  const gateReadiness = computeGateReadiness(messages, triage);

  const activeCount = members.filter((m) => !m.killed && m.status === 'working').length;
  const waitingCount = members.filter((m) => !m.killed && m.status === 'waiting').length;
  const killedCount = members.filter((m) => m.killed).length;
  const lastActivityTs = Math.max(boardStat.mtime || 0, membersFile.mtime || 0, ...members.map((m) => m.transcriptMtime || 0));

  lruSet(summaryMetaCache, cacheKey, {
    checkedAt: now,
    membersKey,
    boardKey,
    trKeys,
    etag,
    summary: {
      id,
      title,
      appData,
      head,
      memberCount: members.length,
      activeCount,
      waitingCount,
      killedCount,
      triageCount: triage.length,
      totalTokens,
      hasPlan: Boolean(plan),
      lastActivityTs,
    },
  }, 8);

  const snap = {
    id,
    title,
    appData,
    dir,
    etag,
    head,
    members,
    messages,
    ...(channels.length ? { channels } : {}),
    edges: [...edges.values()],
    view: vf.view,
    plan,
    frames,
    allowedFiles,
    systemAttention: sysAttention,
    triage,
    burnSummary,
    gateReadiness,
    usage: {
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
    },
  };

  if (includeRaw) {
    let boardRaw = '';
    try {
      boardRaw = boardStat.size > 0 ? readFileSync(boardPath, 'utf-8') : '';
    } catch {}
    snap.raw = { members: membersFile.text || '', board: boardRaw, view: vf.rawJson };
  }

  return snap;
}

const swarmIdsScanCache = new Map(); // rootKey -> { at, entries }

function scanSwarmIds(appDataDirs) {
  const rootKey = appDataDirs.join('\0');
  const now = Date.now();
  const hit = swarmIdsScanCache.get(rootKey);
  if (hit && now - hit.at < SWARM_SCAN_TTL_MS) return hit.entries;

  const seen = new Set();
  const entries = [];
  for (const appData of appDataDirs) {
    for (const id of safeReaddir(join(appData, 'brain'))) {
      if (seen.has(id) || !ID_RE.test(id)) continue;
      if (existsSync(join(swarmDir(appData, id), 'members.json'))) {
        seen.add(id);
        entries.push({ appData, id });
      }
    }
  }
  swarmIdsScanCache.set(rootKey, { at: now, entries });
  return entries;
}

/** Resolve which swarm a conversation belongs to (coordinator dir or member roster). */
export function resolveConversationSwarm(appDataDirs, conv) {
  if (!conv || !ID_RE.test(conv)) return { appData: null, swarm: null, member: null };
  for (const appData of appDataDirs) {
    const membersFile = readSmallCached(join(swarmDir(appData, conv), 'members.json'), smallFileCache, 1024 * 1024);
    if (membersFile.text != null) {
      const roster = parseRoster(membersFile.text);
      const member = Object.entries(roster?.members || {}).find(([, m]) => m?.conversation_id === conv)?.[0] || null;
      return { appData, swarm: conv, member };
    }
  }
  for (const { appData, id } of scanSwarmIds(appDataDirs)) {
    const membersFile = readSmallCached(join(swarmDir(appData, id), 'members.json'), smallFileCache, 1024 * 1024);
    if (!membersFile.text) continue;
    const roster = parseRoster(membersFile.text);
    const member = Object.entries(roster?.members || {}).find(([, m]) => m?.conversation_id === conv)?.[0] || null;
    if (member) return { appData, swarm: id, member };
  }
  return { appData: null, swarm: null, member: null };
}

/** Scan all available local swarms using cached lightweight summary metadata (no AST retention). */
export function listSwarms(appDataDirs, onSnapshot = null) {
  const list = [];
  const now = Date.now();
  for (const { appData, id } of scanSwarmIds(appDataDirs)) {
    const cacheKey = `${appData}\0${id}`;
    const keys = getSwarmMetaKeys(appData, id);
    if (!keys) {
      summaryMetaCache.delete(cacheKey);
      continue;
    }
    const hit = summaryMetaCache.get(cacheKey);
    if (hit && hit.membersKey === keys.membersKey && hit.boardKey === keys.boardKey) {
      if (now - hit.checkedAt < SNAPSHOT_TRANSCRIPT_TTL_MS) {
        list.push(hit.summary);
        continue;
      }
      // Check if any member transcript changed before re-reading board.jsonl
      const mf = readSmallCached(join(swarmDir(appData, id), 'members.json'), smallFileCache, 1024 * 1024);
      const roster = parseRoster(mf.text || '');
      const names = Object.keys(roster?.members || {}).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
      const curTrKeys = names.map((n) => `${n}:${summarizeTranscript(appData, roster.members[n].conversation_id).key}`).join(',');
      if (curTrKeys === hit.trKeys) {
        hit.checkedAt = now;
        list.push(hit.summary);
        continue;
      }
    }
    const snap = buildSwarmSnapshot(appData, id);
    if (!snap) continue;
    if (onSnapshot) onSnapshot(appData, id, snap, keys);
    const entry = summaryMetaCache.get(cacheKey);
    if (entry) list.push(entry.summary);
  }
  list.sort((a, b) => b.activeCount - a.activeCount || b.lastActivityTs - a.lastActivityTs);
  return list;
}

/** Validate and resolve a screenshot frame path listed on the board/view under `<appData>/brain/`. */
export function resolveAllowedFrame(appData, swarmId, targetPath) {
  if (!appData || !swarmId || !ID_RE.test(swarmId) || typeof targetPath !== 'string' || !targetPath) return null;
  const extMatch = targetPath.match(/\.[a-z]+$/i);
  const contentType = extMatch ? FRAME_EXT[extMatch[0].toLowerCase()] : null;
  if (!contentType) return null;

  const dir = swarmDir(appData, swarmId);
  const membersFile = readSmallCached(join(dir, 'members.json'), smallFileCache, 1024 * 1024);
  const roster = parseRoster(membersFile.text || '');
  const narratorName = pickNarrator(roster);
  const vf = readView(appData, swarmId, dir, narratorName ? roster?.members?.[narratorName] : null);
  const viewFrames = Array.isArray(vf.view?.json?.reel?.frames) ? vf.view.json.reel.frames : [];
  let listed = viewFrames.some((f) => f && f.path === targetPath);
  if (!listed) {
    const msgs = streamAllJsonLines(join(dir, 'board.jsonl'));
    listed = postedFrames(roster, msgs).some((f) => f && f.path === targetPath);
  }
  if (!listed) return null;

  let brainReal;
  try {
    brainReal = realpathSync(join(appData, 'brain'));
  } catch {
    return null;
  }
  const real = canonicalFile(targetPath, brainReal.endsWith(sep) ? brainReal : brainReal + sep);
  if (!real) return null;
  try {
    const st = statSync(real);
    if (st.size > MAX_FRAME_BYTES) return null;
    return { real, contentType, size: st.size };
  } catch {
    return null;
  }
}

export function unseenBy(snap, member) {
  const me = member && snap.channels ? snap.members.find((m) => m.name === member) : null;
  if (!me) return {};
  const { visible } = memberView(me.name, me.role, me.channels, snap.messages, snap.channels);
  return { unseen: snap.messages.filter((_, i) => !visible[i]).map((m) => m.seq) };
}
