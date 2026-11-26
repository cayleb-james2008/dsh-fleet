/**
 * Antigravity native swarm & transcript store for Fleet sidecar.
 *
 * Designed for low Peak RSS and high polling throughput on 50k+ transcript lines:
 * - Streams JSONL in bounded 64 KB chunks via openSync/readSync + StringDecoder.
 * - Extracts cumulative token/step telemetry with zero-alloc scalar scanning across
 *   older lines and parses JSON objects ONLY for the 32-line sliding tail window.
 * - Does not retain full parsed board message graphs in long-lived JS heap caches.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  memberView,
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
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const TAIL_ANCHOR_BYTES = 64;
const OPS_FILE = 'fleet_ops.json';
const OPS_RING_LIMIT = 64;
const OPS_MAX_BYTES = 512 * 1024;
export const OPS_TIMEOUT_MS = 45_000;
const OP_STATUSES = new Set(['dispatched', 'verified', 'failed', 'timed_out', 'dismissed']);
const STATE_FILE = 'fleet_state.json';
const STATE_MAX_BYTES = 1024 * 1024;
const SUMMARY_CACHE_LIMIT = 64;
const INACTIVE_SWARM_MS = 5 * 60 * 1000;
const CHECKPOINT_CAP = 64;
const PIN_CAP = 512;
const ACK_CAP = 512;
const MAX_SEQ_VAL = 1_000_000_000;

function cleanTok(v) {
  if (typeof v === 'boolean' || v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeStr(v, fallback = '') {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

function safeSeq(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

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
    return { ino: s.ino, mtime: s.mtimeMs, size: s.size, isFile: s.isFile() };
  } catch {
    return { ino: 0, mtime: 0, size: -1, isFile: false };
  }
}

function lruSet(cache, key, val, limit) {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, val);
}

function readSmallCached(path, cache, maxBytes = VIEW_MAX_BYTES) {
  const s = statOf(path);
  if (s.size < 0 || !s.isFile) {
    cache.delete(path);
    return { text: null, ...s };
  }
  if (s.size > maxBytes) return { text: null, tooLarge: true, ...s };
  const key = `${s.ino}:${s.mtime}:${s.size}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) {
    lruSet(cache, path, hit, 12);
    return { text: hit.text, ...s };
  }
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
const B_TOOL_CALLS = Buffer.from('"tool_calls":');
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
    if (!Number.isFinite(val)) return -1;
    digits++;
    pos++;
  }
  return digits > 0 && Number.isFinite(val) ? val : -1;
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
  if (s.size < 0 || !s.isFile) return { exists: false, meta: null, changed: Boolean(prevMeta) };

  if (prevMeta && prevMeta.ino === s.ino && prevMeta.size === s.size && prevMeta.mtime === s.mtime) {
    return { exists: true, meta: prevMeta, changed: false };
  }

  let isAppend = Boolean(prevMeta && prevMeta.ino === s.ino && s.size > prevMeta.size);
  let offset = isAppend ? prevMeta.size : 0;
  let carryBuf = isAppend && prevMeta.carryBuf ? prevMeta.carryBuf : Buffer.alloc(0);
  let dropUntilNl = isAppend ? Boolean(prevMeta.dropUntilNl) : false;
  let tailAnchor = Buffer.alloc(0);

  if (s.size > 0) {
    let fd;
    try {
      fd = openSync(filePath, 'r');
    } catch {
      return { exists: false, meta: null, changed: Boolean(prevMeta) };
    }
    try {
      if (isAppend && prevMeta.size > 0 && prevMeta.tailAnchor && prevMeta.tailAnchor.length > 0) {
        const anchorLen = prevMeta.tailAnchor.length;
        const anchorBuf = Buffer.allocUnsafe(anchorLen);
        const anchorRead = readSync(fd, anchorBuf, 0, anchorLen, prevMeta.size - anchorLen);
        if (anchorRead !== anchorLen || anchorBuf.compare(prevMeta.tailAnchor) !== 0) {
          isAppend = false;
          offset = 0;
          carryBuf = Buffer.alloc(0);
          dropUntilNl = false;
        }
      }
      if (!isAppend) onReset();

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
          if (dropUntilNl) {
            dropUntilNl = false;
            pos = nl + 1;
            continue;
          }
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
        if (remLen <= 0 || dropUntilNl) {
          sharedCarryLen = 0;
          overflowCarry = Buffer.alloc(0);
        } else if (remLen < CHUNK_BYTES) {
          activeBuf.copy(SHARED_CHUNK_BUF, 0, pos, totalLen);
          sharedCarryLen = remLen;
          overflowCarry = Buffer.alloc(0);
        } else if (remLen > MAX_LINE_BYTES) {
          // Drop oversized unterminated line so corrupt multi-MB data cannot exhaust heap.
          sharedCarryLen = 0;
          overflowCarry = Buffer.alloc(0);
          dropUntilNl = true;
        } else {
          sharedCarryLen = 0;
          overflowCarry = Buffer.from(activeBuf.subarray(pos, totalLen));
        }
      }
      carryBuf = sharedCarryLen > 0 ? Buffer.from(SHARED_CHUNK_BUF.subarray(0, sharedCarryLen)) : overflowCarry;

      const anchorLen = Math.min(TAIL_ANCHOR_BYTES, s.size);
      if (anchorLen > 0) {
        const anchorBuf = Buffer.allocUnsafe(anchorLen);
        const anchorRead = readSync(fd, anchorBuf, 0, anchorLen, s.size - anchorLen);
        if (anchorRead === anchorLen) tailAnchor = anchorBuf;
      }
    } catch {
      return { exists: false, meta: null, changed: Boolean(prevMeta) };
    } finally {
      try {
        closeSync(fd);
      } catch {}
    }
  } else if (!isAppend) {
    onReset();
  }

  if (carryBuf.length) {
    const trimmedCarry = carryBuf.toString('utf8').trim();
    if (trimmedCarry) {
      try {
        const obj = JSON.parse(trimmedCarry);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          if (rawSpan) onLine(carryBuf, 0, carryBuf.length, obj, 0);
          else onLine(trimmedCarry, obj);
        }
        carryBuf = Buffer.alloc(0);
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
    meta: { ino: s.ino, size: s.size, mtime: s.mtime, carryBuf, tailAnchor, dropUntilNl },
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
    const rawMembers = r.members && typeof r.members === 'object' && !Array.isArray(r.members) ? r.members : {};
    const members = {};
    for (const [k, v] of Object.entries(rawMembers)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) members[k] = v;
    }
    return { title: typeof r.title === 'string' ? r.title : '', members };
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
  if (typeof v !== 'string') return safeStr(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return safeStr(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function oneLine(s, maxLen = 96) {
  const out = safeStr(s)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

const maskHomePath = (s) => safeStr(s).replace(/\/(?:home|Users)\/[^/\s"'`]+(\/|$)/g, (_, sepCh) => `~${sepCh}`);

function describeToolCall(tc) {
  const name = safeStr(tc?.name);
  if (!name) return '';
  if (BOARD_ACTIVITY[name]) return BOARD_ACTIVITY[name];
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquote(args.toolSummary) || unquote(args.toolAction) || unquote(args.Description);
  if (summary) return oneLine(maskHomePath(summary));
  if (name === 'run_command' && args.CommandLine) {
    return oneLine(`Run ${maskHomePath(unquote(args.CommandLine))}`, 64);
  }
  if ((name === 'manage_task' || name === 'schedule') && (args.Action || args.Prompt)) {
    return oneLine(maskHomePath(unquote(args.Action || args.Prompt)), 64);
  }
  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile);
  if (filePath) {
    const verb = { read_file: 'Read', write_file: 'Write', edit_file: 'Edit' }[name];
    if (verb) return `${verb} ${basename(filePath)}`;
  }
  if (name === 'code_search' && args.Query) return oneLine(maskHomePath(`Search ${unquote(args.Query)}`));
  if (name === 'swarm' && args.action) return oneLine(`swarm ${unquote(args.action)} ${unquote(args.name)}`);
  return name;
}

function thinkingHeading(thinking) {
  if (typeof thinking !== 'string') return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(maskHomePath(hs[hs.length - 1][1])) : '';
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
  return step.type === 'PLANNER_RESPONSE' && calls.length === 0 ? safeStr(step.content) : null;
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
const activityTailCache = new Map();
const TAIL_PEEK_BYTES = 8192;
const NO_TRANSCRIPT = { key: '-', summary: null };

function parseTailActivitySteps(buf, len, partialStart) {
  const steps = [];
  let pos = 0;
  if (partialStart) {
    const firstNl = buf.indexOf(0x0a, 0);
    if (firstNl < 0 || firstNl >= len) return steps;
    pos = firstNl + 1;
  }
  for (let nl = buf.indexOf(0x0a, pos); nl >= 0 && nl < len; nl = buf.indexOf(0x0a, pos)) {
    const line = buf.toString('utf8', pos, nl).trim();
    pos = nl + 1;
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) steps.push(obj);
    } catch {}
  }
  if (pos < len) {
    const tailLine = buf.toString('utf8', pos, len).trim();
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) steps.push(obj);
      } catch {}
    }
  }
  return steps;
}

/**
 * Bounded, strictly read-only mtime-cached tail reader (~8 KB) exposing
 * a compact 1-line `{ status, label, tool, ts }` activity peek per member
 * with `/home/` and `/Users/` paths masked as `~/`.
 */
export function readTranscriptActivityTail(appData, conv) {
  if (typeof appData !== 'string' || !appData || typeof conv !== 'string' || !conv || !ID_RE.test(conv)) return null;
  const path = transcriptPath(appData, conv);
  let st;
  try {
    st = statSync(path);
    if (!st.isFile()) {
      activityTailCache.delete(path);
      return null;
    }
  } catch {
    activityTailCache.delete(path);
    return null;
  }
  const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
  const cached = activityTailCache.get(path);
  if (cached && cached.key === key) {
    lruSet(activityTailCache, path, cached, 32);
    return cached.peek;
  }

  let bytesRead = 0;
  const offset = Math.max(0, st.size - TAIL_PEEK_BYTES);
  let fd;
  try {
    fd = openSync(path, 'r');
    bytesRead = readSync(fd, SHARED_CHUNK_BUF, 0, Math.min(TAIL_PEEK_BYTES, st.size), offset);
  } catch {
    activityTailCache.delete(path);
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  const steps = parseTailActivitySteps(SHARED_CHUNK_BUF, bytesRead, offset > 0);
  let peek = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) continue;
    if (step.type === 'USER_INPUT') break;
    const stepTs = boardTimeMs(step.created_at) || Math.floor(st.mtimeMs);
    if (step.type === 'ERROR_MESSAGE') {
      peek = {
        status: 'waiting',
        label: oneLine(maskHomePath(safeStr(step.error, 'Model error') || 'Model error'), 96),
        tool: 'error',
        ts: stepTs,
      };
      break;
    }
    if (step.type !== 'PLANNER_RESPONSE') continue;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const labeledCall = [...calls].reverse().find((c) => describeToolCall(c));
    if (labeledCall) {
      const name = safeStr(labeledCall.name);
      const isWaiting = name === 'swarm_wait' || Boolean(labeledCall.args?.IsDaemon);
      peek = {
        status: isWaiting ? 'waiting' : 'working',
        label: maskHomePath(describeToolCall(labeledCall)),
        tool: name || 'tool',
        ts: stepTs,
      };
      break;
    }
    const th = thinkingHeading(step.thinking);
    if (th) {
      peek = {
        status: calls.length === 0 ? 'waiting' : 'working',
        label: maskHomePath(th),
        tool: 'thinking',
        ts: stepTs,
      };
      break;
    }
  }
  if (!peek && st.size > 0) {
    peek = { status: 'waiting', label: 'Idle on turn', tool: '', ts: Math.floor(st.mtimeMs) };
  }
  lruSet(activityTailCache, path, { key, peek }, 32);
  return peek;
}

function num(v) {
  return cleanTok(v);
}

const UNKNOWN_MODEL_SPEC = Object.freeze({
  family: 'unknown',
  contextLimit: 200_000,
  inPer1M: 0,
  cacheReadPer1M: 0,
  outPer1M: 0,
  pricingKnown: false,
});

const CLAUDE_1M_RE = /(?:\[1m\]|(?:^|[-_])1m(?:[-_]|$))/i;
const GEMINI_PRO_FAMILY_RE = /^gemini-(?:2\.5|3(?:\.\d+)?|4(?:\.\d+)?)(?:-|$)|^gemini-.*-pro(?:-|$)|^gemini-pro(?:-|$)/;
const GEMINI_FLASH_FAMILY_RE = /^gemini-(?:2\.5|3(?:\.\d+)?|4(?:\.\d+)?)-flash(?:-|$)|^gemini-.*-flash(?:-|$)/;
const OPENAI_O_SERIES_RE = /^(?:o1|o3|o4)(?:$|[-_])/;

/**
 * Resolve model family, context window ceiling, and per-1M USD token pricing.
 */
export function getModelSpec(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (!raw) return { ...UNKNOWN_MODEL_SPEC };
  const slashIdx = raw.lastIndexOf('/');
  const id = slashIdx >= 0 ? raw.slice(slashIdx + 1) : raw;
  if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype') {
    return { ...UNKNOWN_MODEL_SPEC };
  }

  if (GEMINI_FLASH_FAMILY_RE.test(id)) {
    return {
      family: 'gemini-flash',
      contextLimit: 1_000_000,
      inPer1M: 0.30,
      cacheReadPer1M: 0.075,
      outPer1M: 2.50,
      pricingKnown: true,
    };
  }
  if (GEMINI_PRO_FAMILY_RE.test(id)) {
    return {
      family: 'gemini-pro',
      contextLimit: 1_000_000,
      inPer1M: 1.25,
      cacheReadPer1M: 0.3125,
      outPer1M: 10.0,
      pricingKnown: true,
    };
  }

  if (id.startsWith('claude-') || id === 'claude') {
    const contextLimit = CLAUDE_1M_RE.test(id) ? 1_000_000 : 200_000;
    if (id.includes('opus')) {
      return { family: 'claude-opus', contextLimit, inPer1M: 15.0, cacheReadPer1M: 1.50, outPer1M: 75.0, pricingKnown: true };
    }
    if (id.includes('sonnet')) {
      return { family: 'claude-sonnet', contextLimit, inPer1M: 3.0, cacheReadPer1M: 0.30, outPer1M: 15.0, pricingKnown: true };
    }
    if (id.includes('haiku')) {
      return { family: 'claude-haiku', contextLimit, inPer1M: 1.0, cacheReadPer1M: 0.10, outPer1M: 5.0, pricingKnown: true };
    }
    return { ...UNKNOWN_MODEL_SPEC, contextLimit };
  }

  if (id.startsWith('gpt-5')) {
    if (id.includes('mini') || id.includes('nano')) {
      return { family: 'openai-gpt5-mini', contextLimit: 400_000, inPer1M: 0.25, cacheReadPer1M: 0.025, outPer1M: 2.0, pricingKnown: true };
    }
    return { family: 'openai-gpt5', contextLimit: 400_000, inPer1M: 1.25, cacheReadPer1M: 0.125, outPer1M: 10.0, pricingKnown: true };
  }
  if (OPENAI_O_SERIES_RE.test(id)) {
    if (id.includes('mini')) {
      return { family: 'openai-o-mini', contextLimit: 200_000, inPer1M: 1.10, cacheReadPer1M: 0.275, outPer1M: 4.40, pricingKnown: true };
    }
    return { family: 'openai-o', contextLimit: 200_000, inPer1M: 2.0, cacheReadPer1M: 0.50, outPer1M: 8.0, pricingKnown: true };
  }
  if (id.startsWith('gpt-oss') || id.startsWith('gpt-4o-mini')) {
    return {
      family: id.startsWith('gpt-oss') ? 'openai-gpt-oss' : 'openai-gpt4o-mini',
      contextLimit: 128_000,
      inPer1M: 0.15,
      cacheReadPer1M: 0.075,
      outPer1M: 0.60,
      pricingKnown: true,
    };
  }
  if (id.startsWith('gpt-4') || id.startsWith('gpt-3.5')) {
    return { family: 'openai-gpt4o', contextLimit: 128_000, inPer1M: 2.50, cacheReadPer1M: 1.25, outPer1M: 10.0, pricingKnown: true };
  }

  return { ...UNKNOWN_MODEL_SPEC };
}

function roundUsd(v) {
  const n = Number.isFinite(v) && v > 0 ? v : 0;
  return Math.round(n * 1e6) / 1e6;
}

function roundPct(v) {
  const n = Number.isFinite(v) ? v : 0;
  return Math.round(n * 10) / 10;
}

function sanitizeModelKey(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m || m === '__proto__' || m === 'constructor' || m === 'prototype') return 'unknown';
  return m;
}

function computeContextPct(contextTokens, contextLimit) {
  const tok = cleanTok(contextTokens);
  const limit = cleanTok(contextLimit);
  if (limit <= 0 || tok <= 0) return 0;
  const pct = (tok / limit) * 100;
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : 0;
}

function cloneByModel(byModel) {
  const out = {};
  if (!byModel || typeof byModel !== 'object') return out;
  for (const [k, v] of Object.entries(byModel)) {
    const key = sanitizeModelKey(k);
    if (!v || typeof v !== 'object') continue;
    const prev = out[key];
    if (prev) {
      prev.inputTokens += cleanTok(v.inputTokens);
      prev.cacheReadTokens += cleanTok(v.cacheReadTokens);
      prev.outputTokens += cleanTok(v.outputTokens);
      prev.steps += cleanTok(v.steps);
    } else {
      out[key] = {
        inputTokens: cleanTok(v.inputTokens),
        cacheReadTokens: cleanTok(v.cacheReadTokens),
        outputTokens: cleanTok(v.outputTokens),
        steps: cleanTok(v.steps),
      };
    }
  }
  return out;
}

function computeCostFromByModel(byModel, fallbackModel = '') {
  let inputUsd = 0;
  let cacheReadUsd = 0;
  let outputUsd = 0;
  let cacheSavingsUsd = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let anyKnown = false;
  let hasEntries = false;

  for (const [modelId, entry] of Object.entries(byModel || {})) {
    if (!entry || typeof entry !== 'object') continue;
    hasEntries = true;
    const spec = getModelSpec(modelId);
    const inp = cleanTok(entry.inputTokens);
    const cac = cleanTok(entry.cacheReadTokens);
    const out = cleanTok(entry.outputTokens);
    totalInputTokens += inp;
    totalCacheReadTokens += cac;
    if (spec.pricingKnown) {
      anyKnown = true;
      inputUsd += (inp * spec.inPer1M) / 1e6;
      cacheReadUsd += (cac * spec.cacheReadPer1M) / 1e6;
      outputUsd += (out * spec.outPer1M) / 1e6;
      cacheSavingsUsd += (cac * Math.max(0, spec.inPer1M - spec.cacheReadPer1M)) / 1e6;
    }
  }

  if (!hasEntries && fallbackModel) {
    anyKnown = getModelSpec(fallbackModel).pricingKnown;
  }

  const totalUsd = roundUsd(inputUsd + cacheReadUsd + outputUsd);
  const cacheDenom = totalInputTokens + totalCacheReadTokens;
  const cacheHitPct =
    totalCacheReadTokens > 0 && cacheDenom > 0
      ? roundPct(Math.min(100, Math.max(0, (totalCacheReadTokens / cacheDenom) * 100)))
      : 0;

  return {
    totalUsd,
    inputUsd: roundUsd(inputUsd),
    cacheReadUsd: roundUsd(cacheReadUsd),
    outputUsd: roundUsd(outputUsd),
    cacheSavingsUsd: roundUsd(cacheSavingsUsd),
    cacheHitPct,
    pricingKnown: anyKnown,
  };
}

function setAccModel(a, model) {
  const clean = typeof model === 'string' ? model.trim() : '';
  if (!clean) return '';
  if (a.model !== clean) {
    a.model = clean;
    a.modelBuf = Buffer.from(clean, 'utf8');
  }
  return clean;
}

function extractModelFast(buf, start, end, a) {
  const idx = buf.indexOf(B_MODEL, start);
  if (idx < 0 || idx >= end) return '';
  const tcIdx = buf.indexOf(B_TOOL_CALLS, start);
  if ((idx > start && buf[idx - 1] === 92) || (tcIdx >= 0 && tcIdx < idx && tcIdx < end)) {
    try {
      const parsed = JSON.parse(buf.toString('utf8', start, end));
      return typeof parsed?.model === 'string' ? setAccModel(a, parsed.model) : '';
    } catch {
      return '';
    }
  }
  let pos = idx + B_MODEL.length;
  while (pos < end && (buf[pos] === 32 || buf[pos] === 9)) pos++;
  if (pos >= end || buf[pos] !== 34) return '';
  const qStart = pos + 1;
  const qEnd = buf.indexOf(34, qStart);
  if (qEnd < 0 || qEnd >= end) return '';
  const bs = buf.indexOf(92, qStart);
  if (bs >= 0 && bs < qEnd) return '';
  if (a.modelBuf && qEnd - qStart === a.modelBuf.length && buf.compare(a.modelBuf, 0, a.modelBuf.length, qStart, qEnd) === 0) {
    return a.model;
  }
  return setAccModel(a, buf.toString('utf8', qStart, qEnd));
}

function addByModel(a, modelId, inp, cac, out) {
  const key = sanitizeModelKey(modelId);
  let entry = Object.hasOwn(a.byModel, key) ? a.byModel[key] : null;
  if (!entry) {
    entry = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
    a.byModel[key] = entry;
  }
  entry.inputTokens += cleanTok(inp);
  entry.cacheReadTokens += cleanTok(cac);
  entry.outputTokens += cleanTok(out);
  entry.steps += 1;
}

/**
 * Incrementally scan `transcript.jsonl` with near-zero V8 allocations:
 * - Scalar fields (`input_tokens`, `cache_read_tokens`, `output_tokens`, `step_index`, `model`)
 *   are scanned directly across history without retaining JS objects.
 * - Full `JSON.parse` runs only on the newest 32 lines for `recentTools`, `thinkingHeading`,
 *   `activity`, `turnEnded`, `finalReply`, and `lastContextTokens`.
 */
export function summarizeTranscript(appData, conv) {
  if (typeof appData !== 'string' || !appData || typeof conv !== 'string' || !conv || !ID_RE.test(conv)) return NO_TRANSCRIPT;
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
    modelBuf: null,
    byModel: {},
    startedAt: '',
    lastStepAt: '',
    rawTail: [],
    tailSteps: [],
    recentTools: [],
    latestThinking: '',
    lastError: null,
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
        const rawModel = typeof preParsed.model === 'string' ? setAccModel(a, preParsed.model) : '';
        if (preParsed.type === 'PLANNER_RESPONSE') {
          const u = preParsed.usage && typeof preParsed.usage === 'object' ? preParsed.usage : preParsed;
          const inp = cleanTok(u.input_tokens ?? u.inputTokens);
          const cac = cleanTok(u.cache_read_tokens ?? u.cacheReadTokens);
          const out = cleanTok(u.output_tokens ?? u.outputTokens);
          a.inputTokens += inp;
          a.cacheReadTokens += cac;
          a.outputTokens += out;
          a.lastContextTokens = inp + cac;
          addByModel(a, rawModel || a.model || 'unknown', inp, cac, out);
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
        const stepModel = extractModelFast(buf, start, end, a) || a.model || 'unknown';

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
              inp = cleanTok(u.input_tokens ?? u.inputTokens);
              cac = cleanTok(u.cache_read_tokens ?? u.cacheReadTokens);
              out = cleanTok(u.output_tokens ?? u.outputTokens);
            } catch {
              // torn line skipped
            }
          }
        }
        inp = cleanTok(inp);
        cac = cleanTok(cac);
        out = cleanTok(out);
        a.inputTokens += inp;
        a.cacheReadTokens += cac;
        a.outputTokens += out;
        if (inp + cac > 0 || remBytes <= 12 * 1024) a.lastContextTokens = inp + cac;
        addByModel(a, stepModel, inp, cac, out);
      }
    },
    { rawSpan: true },
  );

  if (!res.exists) {
    transcriptCache.delete(path);
    return NO_TRANSCRIPT;
  }
  if (!res.changed) {
    lruSet(transcriptCache, path, state, 24);
    return state.result;
  }

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
    if (typeof step.model === 'string' && step.model.trim()) setAccModel(a, step.model);
    const stepType = typeof step.type === 'string' ? step.type : '';
    const stepCreatedAt = typeof step.created_at === 'string' ? step.created_at : '';
    const errText =
      typeof step.error === 'string' && step.error
        ? oneLine(step.error, 240)
        : stepType === 'ERROR_MESSAGE' && typeof step.content === 'string'
          ? oneLine(step.content, 240)
          : '';
    if (stepType === 'ERROR_MESSAGE') {
      const parsedErrTs = stepCreatedAt ? Date.parse(stepCreatedAt) : NaN;
      a.lastError = {
        createdAt: stepCreatedAt,
        ts: Number.isFinite(parsedErrTs) ? parsedErrTs : null,
        error: errText || 'model error',
      };
    }
    const th = stepType === 'PLANNER_RESPONSE' ? thinkingHeading(step.thinking) : '';
    if (th) a.latestThinking = th;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const compactCalls = [];
    for (const tc of calls) {
      if (!tc || typeof tc !== 'object') continue;
      const summary = describeToolCall(tc);
      const name = safeStr(tc.name);
      compactCalls.push({ name, summary });
      if (stepType === 'PLANNER_RESPONSE' && summary) {
        a.recentTools.push({
          name: name || 'tool',
          summary,
          time: stepCreatedAt,
        });
        if (a.recentTools.length > RECENT_TOOLS_CAP) a.recentTools.shift();
      }
    }
    a.tailSteps[ti % TAIL_CAP] = {
      type: stepType,
      status: safeStr(step.status),
      error: errText,
      createdAt: stepCreatedAt,
      tool_calls: compactCalls,
      thinkingHeading: th,
      content: stepType === 'PLANNER_RESPONSE' && calls.length === 0 ? safeStr(step.content).slice(0, 1200) : '',
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

  const recentErrors = [];
  for (const step of tailSteps) {
    if (!step || step.type !== 'ERROR_MESSAGE') continue;
    const ts = step.createdAt ? Date.parse(step.createdAt) : NaN;
    recentErrors.push({
      createdAt: step.createdAt || '',
      ts: Number.isFinite(ts) ? ts : null,
      error: step.error || 'model error',
    });
  }
  if (a.lastError && !recentErrors.some((e) => e.createdAt === a.lastError.createdAt && e.error === a.lastError.error)) {
    recentErrors.push(a.lastError);
  }

  const idle = turnEnded(tailSteps);
  const reply = finalReply(tailSteps);
  const replied = reply !== null;
  const replyAsk = replied ? replyQuestion(reply) : '';
  const totalTokens = a.inputTokens + a.cacheReadTokens + a.outputTokens;
  const modelSpec = getModelSpec(a.model);
  const byModel = cloneByModel(a.byModel);
  const cost = computeCostFromByModel(byModel, a.model);
  const contextLimit = modelSpec.contextLimit;
  const contextPct = computeContextPct(a.lastContextTokens || a.inputTokens + a.cacheReadTokens, contextLimit);
  const key = `${res.meta.ino}:${res.meta.mtime}:${res.meta.size}:${a.lineCount}`;

  state.result = {
    key,
    summary: {
      steps: Math.max(a.lineCount, a.maxStepIndex),
      activity,
      activityKind,
      last,
      recentErrors,
      idle,
      replied,
      replyAsk,
      mtime: res.meta.mtime,
      model: a.model,
      modelSpec,
      contextLimit,
      contextPct,
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
      cost,
      byModel,
    },
  };

  lruSet(transcriptCache, path, state, 24);
  return state.result;
}

function statusOf(m, tr) {
  if (m.killed) return 'killed';
  if (m.state === 'stopped' || m.status === 'stopped') return 'stopped';
  if (typeof tr?.idle === 'boolean') return tr.idle ? 'waiting' : 'working';
  if (m.wake_mode === 'mentions' || m.wake_mode === 'anything') return 'waiting';
  return 'working';
}

/** Return live status, failure, and collapsed state for a single swarm member. */
export function getMemberLiveState(appData, memberObj, now = Date.now()) {
  if (!memberObj || typeof memberObj !== 'object') {
    return { status: 'unknown', failure: null, state: 'unknown' };
  }
  const convId = typeof memberObj.conversation_id === 'string' ? memberObj.conversation_id : '';
  const tr = appData && convId ? summarizeTranscript(appData, convId).summary : null;
  const status = statusOf(memberObj, tr);
  const failure = stepFailure(tr, now);
  const state = memberObj.killed ? 'killed' : failure ? 'error' : status;
  return { status, failure, state };
}

function boardTimeMs(t) {
  const s = safeStr(t);
  const ms = s ? Date.parse(s.replace(' ', 'T')) : NaN;
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
    if (!m || typeof m !== 'object') continue;
    const agent = safeStr(m.agent);
    const who = agent && roster?.members && Object.hasOwn(roster.members, agent) ? roster.members[agent] : null;
    if (!who || who.role === 'coordinator' || isRoleWorker(agent, who)) continue;
    const txt = safeStr(m.text);
    if (!/screenshot:/i.test(txt)) continue;
    for (const g of txt.matchAll(SHOT_RE)) {
      out.delete(g[1]);
      out.set(g[1], { path: g[1], seq: safeSeq(m.seq), caption: String(g[2] || '').slice(0, 80) });
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

const PLAN_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const PLAN_CTRL_ALL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const PLAN_SINGLE_CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const MAX_PLAN_ITEMS = 512;
const WS_STATUSES = new Set(['pending', 'running', 'done', 'verified', 'blocked']);
const MS_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked']);
const RISK_SEVERITIES = new Set(['low', 'med', 'high']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLAN_KNOWN_KEYS = new Set([
  'schema',
  'etag',
  'title',
  'goal',
  'goalTitle',
  'goalLine',
  'gate',
  'repo',
  'threads',
  'tasks',
  'workstreams',
  'milestones',
  'risks',
]);

function isPlainObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function cleanPlanStr(v, singleLine = false) {
  const s = safeStr(v);
  if (!s) return '';
  if (singleLine) {
    return s
      .replace(PLAN_CTRL_ALL_RE, '')
      .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
      .trim();
  }
  return s.replace(PLAN_CTRL_ALL_RE, '');
}

function planContentHash(text) {
  const s = typeof text === 'string' ? text : '';
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c >>> 8 ^ (c & 0xff)), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function computePlanEtag(stat, text = null) {
  if (!stat || stat.size < 0) return '';
  if (typeof text === 'string') return `${stat.mtime}:${stat.size}:${planContentHash(text)}`;
  return `${stat.mtime}:${stat.size}`;
}

function normalizeWsStatus(s) {
  if (s === 'in_progress') return 'running';
  return WS_STATUSES.has(s) ? s : 'pending';
}

function normalizeMsStatus(s) {
  if (s === 'running') return 'in_progress';
  if (s === 'verified') return 'done';
  return MS_STATUSES.has(s) ? s : 'pending';
}

/**
 * Normalize native Antigravity (`goal: { title, line }`, `tasks`, `threads`) and Fleet
 * (`workstreams`, `milestones`, `gate`, `risks`) `plan.json` objects into one crash-safe shape.
 */
export function normalizePlan(raw, etag = '') {
  if (!isPlainObj(raw)) return null;
  const hasNativeGoal = isPlainObj(raw.goal);
  const hasNativeTasks = isPlainObj(raw.tasks);
  const hasNativeThreads = Array.isArray(raw.threads);
  const hasNative = hasNativeGoal || hasNativeTasks || hasNativeThreads;
  const hasFleet =
    Array.isArray(raw.workstreams) ||
    Array.isArray(raw.milestones) ||
    Array.isArray(raw.risks) ||
    (typeof raw.gate === 'string' && raw.gate.trim().length > 0);
  const schema = hasNative && hasFleet ? 'hybrid' : hasNative ? 'native' : 'fleet';

  const goalTitle = hasNativeGoal
    ? typeof raw.goal.title === 'string'
      ? cleanPlanStr(raw.goal.title, true)
      : typeof raw.goalTitle === 'string'
        ? cleanPlanStr(raw.goalTitle, true)
        : undefined
    : typeof raw.goalTitle === 'string'
      ? cleanPlanStr(raw.goalTitle, true)
      : undefined;
  const goalLine = hasNativeGoal
    ? typeof raw.goal.line === 'string'
      ? cleanPlanStr(raw.goal.line)
      : typeof raw.goalLine === 'string'
        ? cleanPlanStr(raw.goalLine)
        : undefined
    : typeof raw.goalLine === 'string'
      ? cleanPlanStr(raw.goalLine)
      : undefined;
  const goal = hasNativeGoal
    ? goalLine || goalTitle || ''
    : typeof raw.goal === 'string'
      ? cleanPlanStr(raw.goal)
      : goalLine || goalTitle || '';
  const title =
    typeof raw.title === 'string' && cleanPlanStr(raw.title, true)
      ? cleanPlanStr(raw.title, true)
      : goalTitle || goalLine || '';
  const gate = typeof raw.gate === 'string' ? cleanPlanStr(raw.gate, true) : '';
  const repo = typeof raw.repo === 'string' && cleanPlanStr(raw.repo, true) ? cleanPlanStr(raw.repo, true) : undefined;

  const threads = hasNativeThreads
    ? raw.threads
        .slice(0, MAX_PLAN_ITEMS)
        .filter((t) => isPlainObj(t))
        .map((t, idx) => ({
          id: typeof t.id === 'string' && cleanPlanStr(t.id, true) ? cleanPlanStr(t.id, true) : `t-${idx + 1}`,
          title: typeof t.title === 'string' ? cleanPlanStr(t.title, true) : '',
          goal:
            typeof t.goal === 'string'
              ? cleanPlanStr(t.goal)
              : isPlainObj(t.goal)
                ? cleanPlanStr(t.goal.line || t.goal.title)
                : '',
          tasks: Array.isArray(t.tasks) ? t.tasks.filter((x) => typeof x === 'string').map((x) => cleanPlanStr(x, true)) : [],
        }))
    : [];

  const tasks = {};
  if (hasNativeTasks) {
    let n = 0;
    for (const [k, v] of Object.entries(raw.tasks)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (++n > MAX_PLAN_ITEMS) break;
      const ck = cleanPlanStr(k, true);
      if (!ck) continue;
      tasks[ck] = typeof v === 'string' ? cleanPlanStr(v) : safeStr(v);
    }
  }

  const workstreams = Array.isArray(raw.workstreams)
    ? raw.workstreams
        .slice(0, MAX_PLAN_ITEMS)
        .filter((w) => isPlainObj(w))
        .map((w, idx) => {
          const note = typeof w.note === 'string' ? cleanPlanStr(w.note) : '';
          const threadId = typeof w.threadId === 'string' ? cleanPlanStr(w.threadId, true) : '';
          return {
            id: typeof w.id === 'string' && cleanPlanStr(w.id, true) ? cleanPlanStr(w.id, true) : `ws-${idx + 1}`,
            title: typeof w.title === 'string' ? cleanPlanStr(w.title, true) : '',
            owner: typeof w.owner === 'string' ? cleanPlanStr(w.owner, true) : '',
            status: normalizeWsStatus(w.status),
            ...(note ? { note } : {}),
            ...(threadId ? { threadId } : {}),
          };
        })
    : [];

  const milestones = Array.isArray(raw.milestones)
    ? raw.milestones
        .slice(0, MAX_PLAN_ITEMS)
        .filter((m) => isPlainObj(m))
        .map((m) => ({
          title: typeof m.title === 'string' ? cleanPlanStr(m.title, true) : '',
          status: normalizeMsStatus(m.status),
        }))
    : [];

  const risks = Array.isArray(raw.risks)
    ? raw.risks
        .slice(0, MAX_PLAN_ITEMS)
        .map((r) => {
          if (typeof r === 'string') return { title: cleanPlanStr(r, true) };
          if (!isPlainObj(r)) return null;
          const rTitle =
            typeof r.title === 'string'
              ? cleanPlanStr(r.title, true)
              : typeof r.description === 'string'
                ? cleanPlanStr(r.description, true)
                : '';
          const out = { title: rTitle };
          if (RISK_SEVERITIES.has(r.severity)) out.severity = r.severity;
          return out;
        })
        .filter(Boolean)
    : [];

  return {
    schema,
    etag: typeof etag === 'string' ? etag : '',
    title,
    goal,
    ...(goalTitle !== undefined ? { goalTitle } : {}),
    ...(goalLine !== undefined ? { goalLine } : {}),
    gate,
    ...(repo !== undefined ? { repo } : {}),
    threads,
    tasks,
    workstreams,
    milestones,
    risks,
  };
}

function scanPlanPatchSafety(val, depth = 0) {
  if (depth > 8) return 'Plan patch exceeds maximum nesting depth';
  if (typeof val === 'string') {
    return PLAN_CTRL_RE.test(val) ? 'Control characters are not permitted in plan fields' : null;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const err = scanPlanPatchSafety(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (val && typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_KEYS.has(k)) return 'Forbidden key in plan patch';
      if (PLAN_CTRL_RE.test(k)) return 'Control characters are not permitted in plan fields';
      const err = scanPlanPatchSafety(v, depth + 1);
      if (err) return err;
    }
  }
  return null;
}

/** Validate a `POST /api/plan` patch payload for types, enums, prototype keys, and control chars. */
export function validatePlanPatch(patch) {
  if (!isPlainObj(patch)) {
    return { ok: false, status: 400, error: 'patch object required' };
  }
  const safetyErr = scanPlanPatchSafety(patch, 0);
  if (safetyErr) return { ok: false, status: 400, error: safetyErr };

  for (const field of ['title', 'goalTitle', 'goalLine', 'gate', 'repo']) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') {
      return { ok: false, status: 400, error: `${field} must be a string` };
    }
  }
  if (patch.goal !== undefined) {
    if (typeof patch.goal !== 'string') {
      if (!isPlainObj(patch.goal)) {
        return { ok: false, status: 400, error: 'goal must be a string or { title, line } object' };
      }
      if (patch.goal.title !== undefined && typeof patch.goal.title !== 'string') {
        return { ok: false, status: 400, error: 'goal.title must be a string' };
      }
      if (patch.goal.line !== undefined && typeof patch.goal.line !== 'string') {
        return { ok: false, status: 400, error: 'goal.line must be a string' };
      }
    }
  }
  if (patch.tasks !== undefined) {
    if (!isPlainObj(patch.tasks)) {
      return { ok: false, status: 400, error: 'tasks must be an object map of strings' };
    }
    const taskEntries = Object.entries(patch.tasks);
    if (taskEntries.length > MAX_PLAN_ITEMS) {
      return { ok: false, status: 400, error: `tasks exceeds maximum entries (${MAX_PLAN_ITEMS})` };
    }
    for (const [, v] of taskEntries) {
      if (typeof v !== 'string') {
        return { ok: false, status: 400, error: 'tasks values must be strings' };
      }
    }
  }
  if (patch.threads !== undefined) {
    if (!Array.isArray(patch.threads)) {
      return { ok: false, status: 400, error: 'threads must be an array' };
    }
    if (patch.threads.length > MAX_PLAN_ITEMS) {
      return { ok: false, status: 400, error: `threads exceeds maximum items (${MAX_PLAN_ITEMS})` };
    }
    for (const t of patch.threads) {
      if (!isPlainObj(t)) return { ok: false, status: 400, error: 'each thread must be an object' };
      for (const f of ['id', 'title', 'goal']) {
        if (t[f] !== undefined && typeof t[f] !== 'string') {
          return { ok: false, status: 400, error: `thread.${f} must be a string` };
        }
      }
      if (t.tasks !== undefined && (!Array.isArray(t.tasks) || t.tasks.some((x) => typeof x !== 'string'))) {
        return { ok: false, status: 400, error: 'thread.tasks must be an array of strings' };
      }
    }
  }
  if (patch.workstreams !== undefined) {
    if (!Array.isArray(patch.workstreams)) {
      return { ok: false, status: 400, error: 'workstreams must be an array' };
    }
    if (patch.workstreams.length > MAX_PLAN_ITEMS) {
      return { ok: false, status: 400, error: `workstreams exceeds maximum items (${MAX_PLAN_ITEMS})` };
    }
    for (const w of patch.workstreams) {
      if (!isPlainObj(w)) return { ok: false, status: 400, error: 'each workstream must be an object' };
      for (const f of ['id', 'title', 'owner', 'note', 'threadId']) {
        if (w[f] !== undefined && typeof w[f] !== 'string') {
          return { ok: false, status: 400, error: `workstream.${f} must be a string` };
        }
      }
      if (w.status !== undefined && !WS_STATUSES.has(w.status)) {
        return { ok: false, status: 400, error: 'invalid workstream status' };
      }
    }
  }
  if (patch.milestones !== undefined) {
    if (!Array.isArray(patch.milestones)) {
      return { ok: false, status: 400, error: 'milestones must be an array' };
    }
    if (patch.milestones.length > MAX_PLAN_ITEMS) {
      return { ok: false, status: 400, error: `milestones exceeds maximum items (${MAX_PLAN_ITEMS})` };
    }
    for (const m of patch.milestones) {
      if (!isPlainObj(m)) return { ok: false, status: 400, error: 'each milestone must be an object' };
      if (m.title !== undefined && typeof m.title !== 'string') {
        return { ok: false, status: 400, error: 'milestone.title must be a string' };
      }
      if (m.status !== undefined && !MS_STATUSES.has(m.status)) {
        return { ok: false, status: 400, error: 'invalid milestone status' };
      }
    }
  }
  if (patch.risks !== undefined) {
    if (!Array.isArray(patch.risks)) {
      return { ok: false, status: 400, error: 'risks must be an array' };
    }
    if (patch.risks.length > MAX_PLAN_ITEMS) {
      return { ok: false, status: 400, error: `risks exceeds maximum items (${MAX_PLAN_ITEMS})` };
    }
    for (const r of patch.risks) {
      if (typeof r === 'string') continue;
      if (!isPlainObj(r)) return { ok: false, status: 400, error: 'each risk must be a string or object' };
      if (r.title !== undefined && typeof r.title !== 'string') {
        return { ok: false, status: 400, error: 'risk.title must be a string' };
      }
      if (r.severity !== undefined && !RISK_SEVERITIES.has(r.severity)) {
        return { ok: false, status: 400, error: 'invalid risk severity' };
      }
    }
  }
  return { ok: true };
}

function readView(appData, id, dir, narrator) {
  let vdir = dir;
  let source = 'swarm';
  let jf = readSmallCached(join(dir, 'view.json'), smallFileCache, VIEW_MAX_BYTES);
  const conv = narrator?.conversation_id;
  if (typeof conv === 'string' && ID_RE.test(conv)) {
    const alt = join(appData, 'brain', conv, 'swarm_view');
    const altJson = readSmallCached(join(alt, 'view.json'), smallFileCache, VIEW_MAX_BYTES);
    if (altJson.size >= 0 && (jf.size < 0 || altJson.mtime > jf.mtime)) {
      vdir = alt;
      source = 'narrator';
      jf = altJson;
    }
  }
  const { json, mtime, error } = parseViewJson(vdir, jf);
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
  let raw = null;
  if (pf.size >= 0 && !pf.tooLarge) {
    try {
      const v = JSON.parse(pf.text ?? '');
      if (isPlainObj(v)) raw = v;
    } catch {
      raw = null;
    }
  }
  const etag = computePlanEtag(pf, pf.text);
  const plan = raw ? normalizePlan(raw, etag) : null;
  return { plan, etag, key: etag || `${pf.mtime}:${pf.size}`, mtime: pf.mtime || 0 };
}

/**
 * Atomically update or create `<appData>/brain/<swarmId>/.system_generated/swarm/plan.json`
 * with optimistic ETag CAS, strict path confinement, and native-schema preservation.
 */
export function writeSwarmPlan(appData, swarmId, { ifMatch = '', mode = 'patch', patch = {} } = {}) {
  if (!appData || typeof swarmId !== 'string' || !ID_RE.test(swarmId) || swarmId === '.' || swarmId === '..') {
    return { ok: false, status: 400, error: 'Valid swarmId required' };
  }
  if (mode !== 'patch' && mode !== 'replace') {
    return { ok: false, status: 400, error: 'mode must be "patch" or "replace"' };
  }
  if (ifMatch !== undefined && typeof ifMatch !== 'string') {
    return { ok: false, status: 400, error: 'ifMatch must be a string' };
  }
  if (PLAN_SINGLE_CTRL_RE.test(ifMatch || '')) {
    return { ok: false, status: 400, error: 'Control characters are not permitted in ifMatch' };
  }
  const validPatch = validatePlanPatch(patch);
  if (!validPatch.ok) return validPatch;

  const dir = swarmDir(appData, swarmId);
  if (!existsSync(join(dir, 'members.json'))) {
    return { ok: false, status: 404, error: 'Swarm not found' };
  }
  let brainReal;
  let dirReal;
  try {
    brainReal = realpathSync(join(appData, 'brain'));
    dirReal = realpathSync(dir);
  } catch {
    return { ok: false, status: 404, error: 'Swarm directory not accessible' };
  }
  const brainPrefix = brainReal.endsWith(sep) ? brainReal : brainReal + sep;
  if (!dirReal.startsWith(brainPrefix)) {
    return { ok: false, status: 403, error: 'Swarm path outside brain root' };
  }

  const planPath = join(dirReal, 'plan.json');
  if (existsSync(planPath)) {
    try {
      const planReal = realpathSync(planPath);
      if (!planReal.startsWith(brainPrefix)) {
        return { ok: false, status: 403, error: 'Plan path outside brain root' };
      }
    } catch {
      return { ok: false, status: 403, error: 'Invalid plan path' };
    }
  }

  smallFileCache.delete(join(dir, 'plan.json'));
  smallFileCache.delete(planPath);
  const pfStat = statOf(planPath);
  let existingText = null;
  let existingRaw = null;
  if (pfStat.isFile && pfStat.size >= 0 && pfStat.size <= VIEW_MAX_BYTES) {
    try {
      existingText = readFileSync(planPath, 'utf-8');
      const v = JSON.parse(existingText);
      if (isPlainObj(v)) existingRaw = v;
    } catch {
      existingRaw = null;
    }
  }
  const currentEtag = computePlanEtag(pfStat, existingText);

  const expected = (ifMatch || '').trim();
  if (expected !== currentEtag) {
    return {
      ok: false,
      status: 409,
      error: 'plan changed on disk',
      plan: existingRaw ? normalizePlan(existingRaw, currentEtag) : null,
      etag: currentEtag,
    };
  }

  const base = existingRaw || {};
  const existingHasNativeGoal = isPlainObj(base.goal);
  const existingHasNative =
    existingHasNativeGoal || isPlainObj(base.tasks) || Array.isArray(base.threads);
  const patchHasNativeGoal =
    isPlainObj(patch.goal) ||
    typeof patch.goalTitle === 'string' ||
    typeof patch.goalLine === 'string';

  const next = {};
  if (mode === 'patch') {
    for (const [k, v] of Object.entries(base)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if ((k === 'workstreams' || k === 'milestones' || k === 'risks' || k === 'threads') && !Array.isArray(v)) continue;
      if (k === 'tasks' && !isPlainObj(v)) continue;
      next[k] = v;
    }
  } else if (existingHasNative) {
    for (const [k, v] of Object.entries(base)) {
      if (!FORBIDDEN_KEYS.has(k) && !PLAN_KNOWN_KEYS.has(k)) next[k] = v;
    }
  }

  const useNativeGoal = existingHasNativeGoal || patchHasNativeGoal;
  if (useNativeGoal) {
    const goalObj = existingHasNativeGoal ? { ...base.goal } : {};
    if (!existingHasNativeGoal && typeof base.goal === 'string' && !goalObj.line) {
      goalObj.line = base.goal;
    }
    if (isPlainObj(patch.goal)) {
      if (typeof patch.goal.title === 'string') goalObj.title = cleanPlanStr(patch.goal.title, true);
      if (typeof patch.goal.line === 'string') goalObj.line = cleanPlanStr(patch.goal.line);
    } else if (typeof patch.goal === 'string') {
      goalObj.line = cleanPlanStr(patch.goal);
    }
    if (typeof patch.goalTitle === 'string') goalObj.title = cleanPlanStr(patch.goalTitle, true);
    if (typeof patch.goalLine === 'string') goalObj.line = cleanPlanStr(patch.goalLine);
    if (typeof patch.title === 'string') {
      const cleanTitle = cleanPlanStr(patch.title, true);
      if (typeof patch.goalTitle !== 'string' && (existingHasNativeGoal || !goalObj.title)) {
        goalObj.title = cleanTitle;
      }
      if (
        base.title !== undefined ||
        !existingHasNative ||
        (typeof patch.goalTitle === 'string' && cleanTitle !== cleanPlanStr(patch.goalTitle, true))
      ) {
        next.title = cleanTitle;
      }
    }
    if (goalObj.title === undefined) goalObj.title = typeof next.title === 'string' ? next.title : '';
    if (goalObj.line === undefined) goalObj.line = '';
    next.goal = goalObj;
  } else {
    if (typeof patch.title === 'string') next.title = cleanPlanStr(patch.title, true);
    if (typeof patch.goal === 'string') next.goal = cleanPlanStr(patch.goal);
  }

  if (typeof patch.gate === 'string') next.gate = cleanPlanStr(patch.gate, true);
  if (typeof patch.repo === 'string') next.repo = cleanPlanStr(patch.repo, true);

  if (patch.tasks !== undefined) {
    const cleanTasks = {};
    for (const [k, v] of Object.entries(patch.tasks)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const ck = cleanPlanStr(k, true);
      if (ck) cleanTasks[ck] = cleanPlanStr(v);
    }
    next.tasks = cleanTasks;
  } else if (mode === 'replace' && existingHasNative && isPlainObj(base.tasks)) {
    next.tasks = { ...base.tasks };
  }

  if (patch.threads !== undefined) {
    next.threads = patch.threads.map((t, idx) => {
      const clean = {};
      for (const [k, v] of Object.entries(t)) {
        if (!FORBIDDEN_KEYS.has(k)) clean[k] = v;
      }
      const tid = typeof t.id === 'string' ? cleanPlanStr(t.id, true) : '';
      return {
        ...clean,
        id: tid || `t-${idx + 1}`,
        title: typeof t.title === 'string' ? cleanPlanStr(t.title, true) : '',
        goal: typeof t.goal === 'string' ? cleanPlanStr(t.goal) : '',
        tasks: Array.isArray(t.tasks) ? t.tasks.map((x) => cleanPlanStr(x, true)).filter(Boolean) : [],
      };
    });
  } else if (mode === 'replace' && existingHasNative && Array.isArray(base.threads)) {
    next.threads = base.threads;
  }

  if (patch.workstreams !== undefined) {
    next.workstreams = patch.workstreams.map((w, idx) => {
      const wid = typeof w.id === 'string' ? cleanPlanStr(w.id, true) : '';
      const note = typeof w.note === 'string' ? cleanPlanStr(w.note) : '';
      const threadId = typeof w.threadId === 'string' ? cleanPlanStr(w.threadId, true) : '';
      return {
        id: wid || `ws-${idx + 1}`,
        title: typeof w.title === 'string' ? cleanPlanStr(w.title, true) : '',
        owner: typeof w.owner === 'string' ? cleanPlanStr(w.owner, true) : '',
        status: normalizeWsStatus(w.status),
        ...(note ? { note } : {}),
        ...(threadId ? { threadId } : {}),
      };
    });
  }
  if (patch.milestones !== undefined) {
    next.milestones = patch.milestones.map((m) => ({
      title: typeof m.title === 'string' ? cleanPlanStr(m.title, true) : '',
      status: normalizeMsStatus(m.status),
    }));
  }
  if (patch.risks !== undefined) {
    next.risks = patch.risks.map((r) =>
      typeof r === 'string'
        ? { title: cleanPlanStr(r, true) }
        : {
            title: typeof r.title === 'string' ? cleanPlanStr(r.title, true) : '',
            ...(RISK_SEVERITIES.has(r.severity) ? { severity: r.severity } : {}),
          },
    );
  }

  const serialized = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf-8') > VIEW_MAX_BYTES) {
    return { ok: false, status: 413, error: 'Serialized plan exceeds maximum allowed size' };
  }

  const tmpPath = `${planPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmpPath, serialized, 'utf-8');
    renameSync(tmpPath, planPath);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
  }

  smallFileCache.delete(join(dir, 'plan.json'));
  smallFileCache.delete(planPath);
  summaryMetaCache.delete(`${appData}\0${swarmId}`);

  const afterStat = statOf(planPath);
  const newEtag = computePlanEtag(afterStat, serialized);
  return { ok: true, plan: normalizePlan(next, newEtag), etag: newEtag };
}

function parseOpTimeMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function sanitizeOpPayload(val, depth = 0) {
  if (depth > 4) return null;
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.length > 4000 ? val.slice(0, 4000) : val;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'boolean') return val;
  if (Array.isArray(val)) {
    return val.slice(0, 64).map((item) => sanitizeOpPayload(item, depth + 1));
  }
  if (isPlainObj(val)) {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const sv = sanitizeOpPayload(v, depth + 1);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return null;
}

function normalizeOpRecord(raw) {
  if (!isPlainObj(raw)) return null;
  const opId = typeof raw.opId === 'string' && raw.opId.trim() ? raw.opId.trim().slice(0, 128) : '';
  if (!opId) return null;
  const clientOpId =
    typeof raw.clientOpId === 'string' && raw.clientOpId.trim()
      ? raw.clientOpId.trim().slice(0, 64)
      : null;
  const op = typeof raw.op === 'string' ? raw.op.trim().slice(0, 64) : '';
  const target = typeof raw.target === 'string' ? raw.target.slice(0, 256) : '';
  const payload = isPlainObj(raw.payload) ? sanitizeOpPayload(raw.payload) : {};
  const status = OP_STATUSES.has(raw.status) ? raw.status : 'dispatched';
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt
      ? raw.createdAt
      : typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString();
  const updatedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt
      ? raw.updatedAt
      : typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? new Date(raw.updatedAt).toISOString()
        : createdAt;
  const coordinatorId = typeof raw.coordinatorId === 'string' ? raw.coordinatorId.slice(0, 128) : '';
  const seqNum = Number(raw.resolvedSeq);
  const resolvedSeq = Number.isSafeInteger(seqNum) && seqNum > 0 ? seqNum : null;
  const error = typeof raw.error === 'string' && raw.error ? raw.error.slice(0, 500) : null;

  const rawMeta = isPlainObj(raw._meta) ? raw._meta : {};
  const baselineSeq = Number.isSafeInteger(Number(rawMeta.baselineSeq)) && Number(rawMeta.baselineSeq) > 0
    ? Number(rawMeta.baselineSeq)
    : 0;
  const baselinePlanKey = typeof rawMeta.baselinePlanKey === 'string' ? rawMeta.baselinePlanKey : undefined;
  const dispatchedAt = typeof rawMeta.dispatchedAt === 'string' && rawMeta.dispatchedAt ? rawMeta.dispatchedAt : undefined;
  const existedAtDispatch = rawMeta.existedAtDispatch === true;

  return {
    publicOp: {
      opId,
      clientOpId,
      op,
      target,
      payload,
      status,
      createdAt,
      updatedAt,
      coordinatorId,
      resolvedSeq,
      error,
    },
    meta: {
      ...(baselineSeq > 0 ? { baselineSeq } : {}),
      ...(baselinePlanKey !== undefined ? { baselinePlanKey } : {}),
      ...(dispatchedAt ? { dispatchedAt } : {}),
      ...(existedAtDispatch ? { existedAtDispatch: true } : {}),
    },
  };
}

function parseOpsText(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : isPlainObj(parsed) && Array.isArray(parsed.ops) ? parsed.ops : [];
    const out = [];
    for (const item of arr) {
      const rec = normalizeOpRecord(item);
      if (rec) out.push(rec);
    }
    return out.slice(-OPS_RING_LIMIT);
  } catch {
    return [];
  }
}

function resolveConfinedSwarmFile(appData, swarmId, fileName, label = 'Operator file') {
  if (!appData || typeof appData !== 'string' || typeof swarmId !== 'string' || !ID_RE.test(swarmId) || swarmId === '.' || swarmId === '..') {
    return { ok: false, status: 400, error: 'Valid swarmId required' };
  }
  let brainReal;
  try {
    brainReal = realpathSync(join(appData, 'brain'));
  } catch {
    return { ok: false, status: 404, error: 'Swarm not found' };
  }
  const brainRoot = brainReal.endsWith(sep) ? brainReal : brainReal + sep;
  const swarmPath = join(appData, 'brain', swarmId);
  const sysPath = join(swarmPath, '.system_generated');
  const dirPath = join(sysPath, 'swarm');
  const targetPath = join(dirPath, fileName);
  const membersPath = join(dirPath, 'members.json');

  const expectedSwarm = join(brainReal, swarmId);
  const expectedSys = join(expectedSwarm, '.system_generated');
  const expectedDir = join(expectedSys, 'swarm');
  const expectedTarget = join(expectedDir, fileName);
  const expectedMembers = join(expectedDir, 'members.json');

  for (const [seg, exp] of [
    [swarmPath, expectedSwarm],
    [sysPath, expectedSys],
    [dirPath, expectedDir],
  ]) {
    const st = checkConfinedSegment(seg, exp, brainRoot);
    if (st === 'escape') return { ok: false, status: 403, error: 'Swarm path outside brain root' };
    if (st === 'missing') return { ok: false, status: 404, error: 'Swarm not found' };
  }

  const memSt = checkConfinedSegment(membersPath, expectedMembers, brainRoot);
  if (memSt === 'escape') return { ok: false, status: 403, error: 'Swarm path outside brain root' };
  if (memSt === 'missing') return { ok: false, status: 404, error: 'Swarm not found' };

  const targetSt = checkConfinedSegment(targetPath, expectedTarget, brainRoot);
  if (targetSt === 'escape') return { ok: false, status: 403, error: `${label} path outside brain root` };
  if (targetSt === 'missing') {
    return { ok: true, missing: true, realFile: expectedTarget, dir: dirPath };
  }
  try {
    if (!statSync(expectedTarget).isFile()) {
      return { ok: false, status: 403, error: `Invalid ${label.toLowerCase()} file` };
    }
  } catch {
    return { ok: false, status: 403, error: `Invalid ${label.toLowerCase()} file` };
  }
  return { ok: true, missing: false, realFile: expectedTarget, dir: dirPath };
}

function resolveConfinedOpsPath(appData, swarmId) {
  return resolveConfinedSwarmFile(appData, swarmId, OPS_FILE, 'Operator ops');
}

function resolveConfinedStatePath(appData, swarmId) {
  return resolveConfinedSwarmFile(appData, swarmId, STATE_FILE, 'Operator state');
}

function readOpsMeta(dir, now = Date.now()) {
  const opsPath = join(dir, OPS_FILE);
  const of = readSmallCached(opsPath, smallFileCache, OPS_MAX_BYTES);
  if (of.size < 0 || !of.isFile) {
    return { records: [], opsKey: '0:0:-1', hasFile: false };
  }
  const records = parseOpsText(of.text);
  let hasExpired = false;
  for (const r of records) {
    if (r.publicOp.status !== 'dispatched') continue;
    const sinceMs = parseOpTimeMs(r.meta.dispatchedAt) ?? parseOpTimeMs(r.publicOp.createdAt);
    if (sinceMs !== null && now - sinceMs >= OPS_TIMEOUT_MS) {
      hasExpired = true;
      break;
    }
  }
  return {
    records,
    opsKey: `${of.ino}:${of.mtime}:${of.size}${hasExpired ? ':exp' : ''}`,
    hasFile: true,
  };
}

function writeOpsFileAtomic(realFile, appData, swarmId, records) {
  const ring = records.slice(-OPS_RING_LIMIT);
  const payload = {
    version: 1,
    ops: ring.map((r) => (Object.keys(r.meta).length ? { ...r.publicOp, _meta: r.meta } : r.publicOp)),
  };
  return writeSwarmJsonAtomic(realFile, appData, swarmId, OPS_FILE, payload);
}

/** Read confined operator command ledger for a swarm without mutating disk state. */
export function readOperatorOps(appData, swarmId) {
  const loc = resolveConfinedOpsPath(appData, swarmId);
  if (!loc.ok) return loc;
  if (loc.missing) return { ok: true, ops: [] };
  smallFileCache.delete(loc.realFile);
  const text = readFileSync(loc.realFile, 'utf-8');
  const records = parseOpsText(text);
  return { ok: true, ops: records.map((r) => r.publicOp) };
}

/** Append an operator command entry atomically to the 64-entry confined `fleet_ops.json` ring. */
export function recordOperatorOp(appData, swarmId, entry, internalMeta = {}) {
  const loc = resolveConfinedOpsPath(appData, swarmId);
  if (!loc.ok) return loc;
  let records = [];
  if (!loc.missing) {
    try {
      records = parseOpsText(readFileSync(loc.realFile, 'utf-8'));
    } catch {
      records = [];
    }
  }
  const normalized = normalizeOpRecord({ ...entry, _meta: internalMeta });
  if (!normalized) return { ok: false, status: 400, error: 'Invalid operator command record' };
  records.push(normalized);
  writeOpsFileAtomic(loc.realFile, appData, swarmId, records);
  return { ok: true, op: normalized.publicOp, ops: records.slice(-OPS_RING_LIMIT).map((r) => r.publicOp) };
}

/** Update an existing operator command entry by `opId` atomically inside `fleet_ops.json`. */
export function updateOperatorOp(appData, swarmId, opId, updater) {
  const loc = resolveConfinedOpsPath(appData, swarmId);
  if (!loc.ok) return loc;
  if (loc.missing) return { ok: false, status: 404, error: `Operator command "${opId}" not found` };
  let records = [];
  try {
    records = parseOpsText(readFileSync(loc.realFile, 'utf-8'));
  } catch {
    records = [];
  }
  const idx = records.findIndex((r) => r.publicOp.opId === opId);
  if (idx < 0) return { ok: false, status: 404, error: `Operator command "${opId}" not found` };
  const current = records[idx];
  const updated = typeof updater === 'function' ? updater(current) : current;
  const normalized = normalizeOpRecord({
    ...(updated?.publicOp || current.publicOp),
    _meta: updated?.meta || current.meta,
  });
  if (!normalized) return { ok: false, status: 400, error: 'Invalid operator command update' };
  records[idx] = normalized;
  writeOpsFileAtomic(loc.realFile, appData, swarmId, records);
  return { ok: true, op: normalized.publicOp, ops: records.map((r) => r.publicOp) };
}

function writeSwarmJsonAtomic(realFile, appData, swarmId, fileName, payload) {
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  const tmpPath = `${realFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmpPath, serialized, 'utf-8');
    renameSync(tmpPath, realFile);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
  }
  smallFileCache.delete(realFile);
  smallFileCache.delete(join(swarmDir(appData, swarmId), fileName));
  summaryMetaCache.delete(`${appData}\0${swarmId}`);
  const st = statOf(realFile);
  return `${st.ino}:${st.mtime}:${st.size}`;
}

function emptyFleetState() {
  return { pinnedSeqs: [], ackedTriage: {}, archived: false, checkpoints: [] };
}

function normalizeAckEntry(raw) {
  if (!isPlainObj(raw)) return null;
  const atNum = Number(raw.at);
  const at = Number.isFinite(atNum) && atNum >= 0 ? Math.round(atNum) : Date.now();
  const seqNum = Number(raw.untilSeq);
  const untilSeq = Number.isSafeInteger(seqNum) && seqNum >= 0 && seqNum <= MAX_SEQ_VAL ? seqNum : 0;
  const note = typeof raw.note === 'string' ? cleanPlanStr(raw.note, false).slice(0, 500) : '';
  return { at, untilSeq, ...(note ? { note } : {}) };
}

function normalizeCheckpointWorktree(raw) {
  if (!isPlainObj(raw)) return null;
  const path = typeof raw.path === 'string' ? cleanPlanStr(raw.path, true).slice(0, 1024) : '';
  if (!path) return null;
  const root = typeof raw.root === 'string' ? cleanPlanStr(raw.root, true).slice(0, 1024) : '';
  const name = typeof raw.name === 'string' && raw.name ? cleanPlanStr(raw.name, true).slice(0, 256) : basename(path);
  const branch = typeof raw.branch === 'string' ? cleanPlanStr(raw.branch, true).slice(0, 128) : '';
  const head = typeof raw.head === 'string' ? cleanPlanStr(raw.head, true).slice(0, 64) : '';
  const shortHead = typeof raw.shortHead === 'string' && raw.shortHead ? cleanPlanStr(raw.shortHead, true).slice(0, 16) : head.slice(0, 8);
  return {
    root,
    path,
    name,
    branch,
    head,
    shortHead,
    clean: raw.clean !== false,
    isMain: Boolean(raw.isMain),
    detached: Boolean(raw.detached),
  };
}

function normalizeCheckpointMember(raw) {
  if (!isPlainObj(raw)) return null;
  const name = typeof raw.name === 'string' ? cleanPlanStr(raw.name, true).slice(0, 128) : '';
  if (!name || FORBIDDEN_KEYS.has(name)) return null;
  return {
    name,
    conversation_id: typeof raw.conversation_id === 'string' ? cleanPlanStr(raw.conversation_id, true).slice(0, 128) : '',
    role: typeof raw.role === 'string' ? cleanPlanStr(raw.role, true).slice(0, 64) : '',
    model: typeof raw.model === 'string' ? cleanPlanStr(raw.model, true).slice(0, 128) : '',
    status: typeof raw.status === 'string' ? cleanPlanStr(raw.status, true).slice(0, 32) : 'unknown',
    killed: Boolean(raw.killed),
    steps: cleanTok(raw.steps),
    workspace_mode: typeof raw.workspace_mode === 'string' ? cleanPlanStr(raw.workspace_mode, true).slice(0, 32) : 'inherit',
    workspace: typeof raw.workspace === 'string' ? cleanPlanStr(raw.workspace, true).slice(0, 1024) : '',
  };
}

function normalizeCheckpointRecord(raw) {
  if (!isPlainObj(raw)) return null;
  const id = typeof raw.id === 'string' ? cleanPlanStr(raw.id, true).slice(0, 128) : '';
  const label = typeof raw.label === 'string' ? cleanPlanStr(raw.label, true).slice(0, 160) : '';
  if (!id || !label) return null;
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt
      ? raw.createdAt
      : typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString();
  const headNum = Number(raw.head);
  const head = Number.isSafeInteger(headNum) && headNum >= 0 ? headNum : 0;
  const costUsd = roundUsd(cleanTok(raw.costUsd));
  const plan = isPlainObj(raw.plan) ? normalizePlan(raw.plan, typeof raw.plan.etag === 'string' ? raw.plan.etag : '') : null;
  const members = Array.isArray(raw.members) ? raw.members.slice(0, 64).map(normalizeCheckpointMember).filter(Boolean) : [];
  const worktrees = Array.isArray(raw.worktrees) ? raw.worktrees.slice(0, 64).map(normalizeCheckpointWorktree).filter(Boolean) : [];
  return { id, label, createdAt, head, costUsd, plan, members, worktrees };
}

function normalizeFleetState(raw) {
  if (!isPlainObj(raw)) return emptyFleetState();
  const pinSet = new Set();
  if (Array.isArray(raw.pinnedSeqs)) {
    for (const v of raw.pinnedSeqs) {
      const s = safeSeq(v);
      if (s > 0 && s <= MAX_SEQ_VAL) pinSet.add(s);
    }
  }
  const pinnedSeqs = [...pinSet].sort((a, b) => a - b).slice(0, PIN_CAP);

  const ackedTriage = {};
  if (isPlainObj(raw.ackedTriage)) {
    let count = 0;
    for (const [k, v] of Object.entries(raw.ackedTriage)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const key = cleanPlanStr(k, true).slice(0, 256);
      if (!key) continue;
      const entry = normalizeAckEntry(v);
      if (!entry) continue;
      ackedTriage[key] = entry;
      if (++count >= ACK_CAP) break;
    }
  }

  const archived = Boolean(raw.archived);
  const checkpoints = Array.isArray(raw.checkpoints)
    ? raw.checkpoints.map(normalizeCheckpointRecord).filter(Boolean).slice(0, CHECKPOINT_CAP)
    : [];
  return { pinnedSeqs, ackedTriage, archived, checkpoints };
}

function parseFleetStateText(text) {
  if (!text) return emptyFleetState();
  try {
    return normalizeFleetState(JSON.parse(text));
  } catch {
    return emptyFleetState();
  }
}

function readFleetStateMeta(dir) {
  const statePath = join(dir, STATE_FILE);
  const sf = readSmallCached(statePath, smallFileCache, STATE_MAX_BYTES);
  if (sf.size < 0 || !sf.isFile) {
    return { state: emptyFleetState(), stateKey: '0:0:-1', hasFile: false };
  }
  return {
    state: parseFleetStateText(sf.text),
    stateKey: `${sf.ino}:${sf.mtime}:${sf.size}`,
    hasFile: true,
  };
}

function isTriageAckActive(entry, head = 0) {
  if (!entry || typeof entry !== 'object') return false;
  const untilSeq = Number(entry.untilSeq);
  if (!Number.isSafeInteger(untilSeq) || untilSeq <= 0) return true;
  return head <= untilSeq;
}

/** Read confined `fleet_state.json` for a swarm without mutating disk state. */
export function readFleetState(appData, swarmId) {
  const loc = resolveConfinedStatePath(appData, swarmId);
  if (!loc.ok) return loc;
  if (loc.missing) return { ok: true, state: emptyFleetState(), missing: true };
  smallFileCache.delete(loc.realFile);
  try {
    const text = readFileSync(loc.realFile, 'utf-8');
    return { ok: true, state: parseFleetStateText(text), missing: false };
  } catch {
    return { ok: true, state: emptyFleetState(), missing: false };
  }
}

function mutateFleetState(appData, swarmId, mutator) {
  const loc = resolveConfinedStatePath(appData, swarmId);
  if (!loc.ok) return loc;
  let state = emptyFleetState();
  if (!loc.missing) {
    try {
      state = parseFleetStateText(readFileSync(loc.realFile, 'utf-8'));
    } catch {
      state = emptyFleetState();
    }
  }
  const res = mutator(state, loc);
  if (res && res.ok === false) return res;
  const normalized = normalizeFleetState(res?.state || state);
  writeSwarmJsonAtomic(loc.realFile, appData, swarmId, STATE_FILE, { version: 1, ...normalized });
  return { ok: true, state: normalized, ...(res?.extra || {}) };
}

function readBoardHeadQuick(appData, swarmId) {
  const dir = swarmDir(appData, swarmId);
  const boardPath = join(dir, 'board.jsonl');
  const boardStat = statOf(boardPath);
  if (!boardStat.isFile || boardStat.size <= 0) return 0;
  const cached = boardTailCache.get(dir);
  if (
    cached &&
    cached.meta &&
    cached.meta.ino === boardStat.ino &&
    cached.meta.size === boardStat.size &&
    cached.meta.mtime === boardStat.mtime
  ) {
    return cached.acc?.head || 0;
  }
  let head = 0;
  let lineCount = 0;
  streamLinesIncremental(
    boardPath,
    null,
    () => {
      head = 0;
      lineCount = 0;
    },
    (buf, start, end, preParsed) => {
      lineCount++;
      if (preParsed) {
        const s = safeSeq(preParsed.seq);
        if (s > head) head = s;
        return;
      }
      const seqIdx = buf.indexOf(Buffer.from('"seq":'), start);
      if (seqIdx >= 0 && seqIdx < end) {
        const s = extractIntSpan(buf, start, end, Buffer.from('"seq":'));
        if (s > head) head = s;
      }
    },
    { rawSpan: true },
  );
  return head || lineCount;
}

/** Persist ack, snooze, or unack state for a triage item in `fleet_state.json`. */
export function ackTriageItem(appData, swarmId, { triageId, action = 'ack', untilSeq, note } = {}) {
  const id = typeof triageId === 'string' ? cleanPlanStr(triageId, true).slice(0, 256) : '';
  if (!id || FORBIDDEN_KEYS.has(id)) {
    return { ok: false, status: 400, error: 'Valid triageId required' };
  }
  if (action !== 'ack' && action !== 'snooze' && action !== 'unack') {
    return { ok: false, status: 400, error: 'action must be ack, snooze, or unack' };
  }
  if (untilSeq !== undefined && untilSeq !== null) {
    if (typeof untilSeq !== 'number' || !Number.isSafeInteger(untilSeq) || untilSeq < 0 || untilSeq > MAX_SEQ_VAL) {
      return { ok: false, status: 400, error: 'untilSeq must be a non-negative integer' };
    }
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return { ok: false, status: 400, error: 'note must be a string' };
  }
  if (typeof note === 'string' && PLAN_CTRL_RE.test(note)) {
    return { ok: false, status: 400, error: 'Control characters are not permitted in note' };
  }
  const cleanNote = typeof note === 'string' ? cleanPlanStr(note, false).slice(0, 500) : '';
  const now = Date.now();
  const boardHead = action === 'snooze' && !(typeof untilSeq === 'number' && untilSeq > 0) ? readBoardHeadQuick(appData, swarmId) : 0;

  return mutateFleetState(appData, swarmId, (state) => {
    if (action === 'unack') {
      delete state.ackedTriage[id];
    } else if (action === 'snooze') {
      const targetSeq = typeof untilSeq === 'number' && untilSeq > 0 ? untilSeq : Math.max(0, boardHead) + 5;
      state.ackedTriage[id] = {
        at: now,
        untilSeq: targetSeq,
        ...(cleanNote ? { note: cleanNote } : {}),
      };
    } else {
      state.ackedTriage[id] = {
        at: now,
        untilSeq: typeof untilSeq === 'number' && untilSeq > 0 ? untilSeq : 0,
        ...(cleanNote ? { note: cleanNote } : {}),
      };
    }
    return { ok: true, state, extra: { triageId: id, action } };
  });
}

/** Pin or unpin a board sequence number in `fleet_state.json`. */
export function setSwarmPin(appData, swarmId, { seq, pinned } = {}) {
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0 || seq > MAX_SEQ_VAL) {
    return { ok: false, status: 400, error: 'seq must be a positive integer' };
  }
  if (typeof pinned !== 'boolean') {
    return { ok: false, status: 400, error: 'pinned must be a boolean' };
  }
  return mutateFleetState(appData, swarmId, (state) => {
    const next = new Set(state.pinnedSeqs);
    if (pinned) next.add(seq);
    else next.delete(seq);
    state.pinnedSeqs = [...next].sort((a, b) => a - b);
    return { ok: true, state, extra: { seq, pinned } };
  });
}

/** Persist swarm archive toggle in `fleet_state.json`. */
export function setSwarmArchived(appData, swarmId, archived) {
  if (typeof archived !== 'boolean') {
    return { ok: false, status: 400, error: 'archived must be a boolean' };
  }
  return mutateFleetState(appData, swarmId, (state) => {
    state.archived = archived;
    return { ok: true, state, extra: { archived } };
  });
}

/** List persisted checkpoints for a swarm under `brain/` confinement. */
export function listCheckpoints(appData, swarmId) {
  const res = readFleetState(appData, swarmId);
  if (!res.ok) return res;
  return { ok: true, checkpoints: res.state.checkpoints };
}

function checkpointPlanToPatch(plan) {
  if (!isPlainObj(plan)) return null;
  const patch = {};
  if (typeof plan.title === 'string' && plan.title) patch.title = plan.title;
  const isNative = plan.schema === 'native' || plan.schema === 'hybrid';
  if (isNative) {
    patch.goal = {
      title: typeof plan.goalTitle === 'string' ? plan.goalTitle : '',
      line: typeof plan.goalLine === 'string' ? plan.goalLine : typeof plan.goal === 'string' ? plan.goal : '',
    };
    if (isPlainObj(plan.tasks)) patch.tasks = plan.tasks;
    if (Array.isArray(plan.threads)) patch.threads = plan.threads;
  } else if (typeof plan.goal === 'string') {
    patch.goal = plan.goal;
  }
  if (typeof plan.gate === 'string') patch.gate = plan.gate;
  if (typeof plan.repo === 'string' && plan.repo) patch.repo = plan.repo;
  if (Array.isArray(plan.workstreams)) patch.workstreams = plan.workstreams;
  if (Array.isArray(plan.milestones)) patch.milestones = plan.milestones;
  if (Array.isArray(plan.risks)) patch.risks = plan.risks;
  return patch;
}

function buildCheckpointResumePrompt(checkpoint, swarmTitle = '') {
  const title = cleanPlanStr(swarmTitle || checkpoint.plan?.title || 'Swarm', true);
  const lines = [
    `[fleet-checkpoint-resume] id=${checkpoint.id} label=${JSON.stringify(checkpoint.label)} createdAt=${checkpoint.createdAt}`,
    `Swarm: ${title} | Board head: #${checkpoint.head} | Spend: $${Number(checkpoint.costUsd || 0).toFixed(4)}`,
  ];
  if (checkpoint.plan) {
    if (checkpoint.plan.goal) lines.push(`Goal: ${oneLine(checkpoint.plan.goal, 200)}`);
    if (checkpoint.plan.gate) lines.push(`Gate: ${oneLine(checkpoint.plan.gate, 160)}`);
    const openWs = (checkpoint.plan.workstreams || []).filter((w) => w.status !== 'done' && w.status !== 'verified');
    if (openWs.length) {
      lines.push(
        `Open workstreams (${openWs.length}): ${openWs.map((w) => `${w.id || w.title}[${w.status}${w.owner ? ` @${w.owner}` : ''}]`).join(', ')}`,
      );
    }
  }
  const activeMembers = (checkpoint.members || []).filter((m) => !m.killed);
  if (activeMembers.length) {
    lines.push(
      `Members (${activeMembers.length}): ${activeMembers.map((m) => `${m.name}(${m.status}${m.model ? `, ${m.model}` : ''})`).join(', ')}`,
    );
  }
  if (Array.isArray(checkpoint.worktrees) && checkpoint.worktrees.length) {
    lines.push(
      `Worktrees: ${checkpoint.worktrees.map((w) => `${w.name}@${w.branch}(${w.shortHead || w.head.slice(0, 8)}, ${w.clean ? 'clean' : 'dirty'})`).join(', ')}`,
    );
  }
  lines.push(`Resume instructions: Read board from #${checkpoint.head}, verify worktree state above, and continue remaining tasks.`);
  return lines.join('\n');
}

/** Capture a durable swarm checkpoint (board head, spend, plan, members, git worktree HEADs/clean flags). */
export async function createCheckpoint(appData, swarmId, { label, roots = [] } = {}) {
  const cleanLabel = typeof label === 'string' ? cleanPlanStr(label, true).slice(0, 160) : '';
  if (!cleanLabel) {
    return { ok: false, status: 400, error: 'Non-empty checkpoint label required' };
  }
  if (typeof label === 'string' && PLAN_SINGLE_CTRL_RE.test(label)) {
    return { ok: false, status: 400, error: 'Control characters are not permitted in label' };
  }
  if (roots !== undefined && !Array.isArray(roots)) {
    return { ok: false, status: 400, error: 'roots must be an array of paths' };
  }

  const loc = resolveConfinedStatePath(appData, swarmId);
  if (!loc.ok) return loc;

  const snap = buildSwarmSnapshot(appData, swarmId);
  if (!snap) return { ok: false, status: 404, error: 'Swarm not found' };

  const memberPaths = snap.members
    .map((m) => (typeof m.workspace === 'string' ? m.workspace : ''))
    .filter(Boolean);
  const { probeCheckpointWorktrees } = await import('./git_probe.mjs');
  const wtProbe = await probeCheckpointWorktrees(roots || [], memberPaths);

  const checkpoint = normalizeCheckpointRecord({
    id: `ckpt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    label: cleanLabel,
    createdAt: new Date().toISOString(),
    head: snap.head,
    costUsd: snap.cost?.totalUsd || 0,
    plan: snap.plan || null,
    members: snap.members.map((m) => ({
      name: m.name,
      conversation_id: m.conversation_id,
      role: m.role,
      model: m.model,
      status: m.status,
      killed: Boolean(m.killed),
      steps: m.steps || 0,
      workspace_mode: m.workspace_mode || 'inherit',
      workspace: m.workspace || '',
    })),
    worktrees: wtProbe.worktrees,
  });

  const saved = mutateFleetState(appData, swarmId, (state) => {
    state.checkpoints = [checkpoint, ...state.checkpoints].slice(0, CHECKPOINT_CAP);
    return { ok: true, state };
  });
  if (!saved.ok) return saved;
  return {
    ok: true,
    checkpoint,
    checkpoints: saved.state.checkpoints,
    rejectedRoots: wtProbe.rejected,
  };
}

/** Restore a checkpoint's `plan.json` (with CAS) or build a structured continuation prompt. */
export function restoreCheckpoint(appData, swarmId, { checkpointId, mode = 'resume_prompt', ifMatch } = {}) {
  const ckId = typeof checkpointId === 'string' ? cleanPlanStr(checkpointId, true).slice(0, 128) : '';
  if (!ckId) {
    return { ok: false, status: 400, error: 'Valid checkpointId required' };
  }
  if (mode !== 'plan' && mode !== 'resume_prompt') {
    return { ok: false, status: 400, error: 'mode must be "plan" or "resume_prompt"' };
  }
  if (ifMatch !== undefined && typeof ifMatch !== 'string') {
    return { ok: false, status: 400, error: 'ifMatch must be a string' };
  }
  if (typeof ifMatch === 'string' && PLAN_SINGLE_CTRL_RE.test(ifMatch)) {
    return { ok: false, status: 400, error: 'Control characters are not permitted in ifMatch' };
  }

  const stateRes = readFleetState(appData, swarmId);
  if (!stateRes.ok) return stateRes;
  const checkpoint = stateRes.state.checkpoints.find((c) => c.id === ckId);
  if (!checkpoint) {
    return { ok: false, status: 404, error: `Checkpoint "${ckId}" not found` };
  }

  if (mode === 'plan') {
    if (!checkpoint.plan) {
      return { ok: false, status: 400, error: 'Checkpoint has no saved plan to restore' };
    }
    const patch = checkpointPlanToPatch(checkpoint.plan);
    const liveEtag = ifMatch !== undefined ? ifMatch.trim() : readPlan(swarmDir(appData, swarmId)).etag;
    const written = writeSwarmPlan(appData, swarmId, {
      ifMatch: liveEtag,
      mode: 'replace',
      patch,
    });
    if (!written.ok) return written;
    return {
      ok: true,
      mode: 'plan',
      checkpointId: ckId,
      checkpoint,
      plan: written.plan,
      etag: written.etag,
    };
  }

  const roster = getSwarmRoster(appData, swarmId);
  const prompt = buildCheckpointResumePrompt(checkpoint, roster?.title || swarmId);
  return {
    ok: true,
    mode: 'resume_prompt',
    checkpointId: ckId,
    checkpoint,
    prompt,
    directive: prompt,
  };
}

function hasOpIdTag(text, opId) {
  if (!text || !opId) return false;
  let idx = text.indexOf(opId);
  while (idx >= 0) {
    const before = text.slice(Math.max(0, idx - 6), idx).toLowerCase();
    const afterChar = idx + opId.length < text.length ? text[idx + opId.length] : '';
    const afterOk = !afterChar || !/[A-Za-z0-9_-]/.test(afterChar);
    if (afterOk && (before.endsWith('opid=') || before.endsWith('[opid='))) {
      return true;
    }
    idx = text.indexOf(opId, idx + opId.length);
  }
  return false;
}

function normOpText(s) {
  return safeStr(s).replace(/\s+/g, ' ').trim();
}

function matchBoardMessageForOp(rec, msg, sinceMs) {
  if (!msg || typeof msg !== 'object') return false;
  const { publicOp: op, meta: internal } = rec;
  const seq = safeSeq(msg.seq);
  const baselineSeq = internal.baselineSeq || 0;
  const msgTs = typeof msg.ts === 'number' && Number.isFinite(msg.ts) ? msg.ts : boardTimeMs(msg.time);

  if (baselineSeq > 0) {
    if (seq > 0 && seq <= baselineSeq) return false;
  } else if (sinceMs !== null && msgTs !== null && msgTs < sinceMs) {
    return false;
  }

  const text = safeStr(msg.text);
  if (hasOpIdTag(text, op.opId)) return true;

  const p = op.payload || {};
  if (op.op === 'channel_op') {
    const c = controlOf(msg);
    if (!c) return false;
    if (c.op !== p.action || c.channel !== p.channel) return false;
    if ((p.action === 'subscribe' || p.action === 'unsubscribe') && p.member) {
      return Array.isArray(c.members) && c.members.includes(p.member);
    }
    return true;
  }

  if (controlOf(msg)) return false;

  if (op.op === 'board_post') {
    const expectedChannel = typeof p.channel === 'string' && p.channel ? p.channel : MAIN;
    if (channelOf(msg) !== expectedChannel) return false;
    const replySeq = Number(p.replyToSeq) || 0;
    if (replySeq > 0) {
      const explicitReply = Number(msg.replyToSeq ?? msg.reply_to) || 0;
      if (explicitReply !== replySeq && !text.includes(`#${replySeq}`)) return false;
    }
    const expectedSnippet = normOpText(p.text).slice(0, 64);
    if (!expectedSnippet) return true;
    return normOpText(text).includes(expectedSnippet);
  }

  if (op.op === 'gate_verdict') {
    const verdict = typeof p.verdict === 'string' ? p.verdict : '';
    const verdictMatch =
      verdict === 'ship'
        ? /\[ship\]|\bshipped\b/i.test(text)
        : verdict === 'verified'
          ? /\[verified\]/i.test(text)
          : verdict === 'blocked'
            ? /\[blocked\]/i.test(text)
            : false;
    if (!verdictMatch) return false;
    const targetSeq = Number(p.seq) || 0;
    if (targetSeq > 0) {
      const explicitReply = Number(msg.replyToSeq ?? msg.reply_to) || 0;
      if (explicitReply !== targetSeq && !text.includes(`#${targetSeq}`)) return false;
    }
    return true;
  }

  return false;
}

/**
 * Reconcile persisted `fleet_ops.json` entries against current `members.json`,
 * `board.jsonl`, `plan.json`, and coordinator transcript `ERROR_MESSAGE` steps.
 */
export function reconcileOperatorOps(appData, swarmId, { meta = null, messages = null, now = Date.now() } = {}) {
  const loc = resolveConfinedOpsPath(appData, swarmId);
  if (!loc.ok || loc.missing) {
    return { ops: [], opsKey: '0:0:-1' };
  }

  const opsStat = statOf(loc.realFile);
  if (opsStat.size < 0 || !opsStat.isFile) {
    return { ops: [], opsKey: '0:0:-1' };
  }

  let records;
  if (meta?.opsMeta?.hasFile) {
    records = meta.opsMeta.records.map((r) => ({
      publicOp: { ...r.publicOp },
      meta: { ...r.meta },
    }));
  } else {
    try {
      records = parseOpsText(readFileSync(loc.realFile, 'utf-8'));
    } catch {
      records = [];
    }
  }

  if (records.length === 0) {
    return { ops: [], opsKey: `${opsStat.ino}:${opsStat.mtime}:${opsStat.size}` };
  }

  const hasDispatched = records.some((r) => r.publicOp.status === 'dispatched');
  if (!hasDispatched) {
    return {
      ops: records.map((r) => r.publicOp),
      opsKey: `${opsStat.ino}:${opsStat.mtime}:${opsStat.size}`,
    };
  }

  const resolvedMeta = meta || readSwarmMeta(appData, swarmId, now);
  if (!resolvedMeta) {
    return {
      ops: records.map((r) => r.publicOp),
      opsKey: `${opsStat.ino}:${opsStat.mtime}:${opsStat.size}`,
    };
  }

  let boardMsgs = messages;
  if (!boardMsgs) {
    boardMsgs = resolvedMeta.boardStat.size > 0 ? streamBoardLines(resolvedMeta.boardPath, null).parsed : [];
  }

  const membersMap = resolvedMeta.roster?.members && typeof resolvedMeta.roster.members === 'object'
    ? resolvedMeta.roster.members
    : {};
  const coordName =
    resolvedMeta.names.find((n) => roleOf(n, membersMap[n]) === 'coordinator' || n === 'coordinator') || '';
  const coordTr = coordName ? resolvedMeta.transcripts.get(coordName)?.summary : null;
  const nowIso = new Date(now).toISOString();
  let dirty = false;

  for (const rec of records) {
    const op = rec.publicOp;
    if (op.status !== 'dispatched') continue;

    const sinceMs = parseOpTimeMs(rec.meta.dispatchedAt) ?? parseOpTimeMs(op.createdAt);
    const p = op.payload || {};
    let verifiedSeq = null;
    let verified = false;

    // 1. Check board.jsonl ([opId=...], channel_op, board_post, gate_verdict)
    for (let i = 0; i < boardMsgs.length; i++) {
      const msg = boardMsgs[i];
      if (matchBoardMessageForOp(rec, msg, sinceMs)) {
        verified = true;
        const seq = safeSeq(msg.seq);
        if (seq > 0) verifiedSeq = seq;
        break;
      }
    }

    // 2. Check members.json for spawn_worker, switch_model, kill_worker
    if (!verified) {
      if (op.op === 'spawn_worker') {
        const name = typeof p.name === 'string' && p.name ? p.name : op.target;
        const m = name && Object.hasOwn(membersMap, name) ? membersMap[name] : null;
        if (m && !m.killed) verified = true;
      } else if (op.op === 'switch_model') {
        const name = typeof p.member === 'string' && p.member ? p.member : op.target;
        const m = name && Object.hasOwn(membersMap, name) ? membersMap[name] : null;
        if (m && !m.killed && typeof p.model === 'string' && p.model && m.model === p.model) {
          verified = true;
        }
      } else if (op.op === 'kill_worker') {
        const name = typeof p.member === 'string' && p.member ? p.member : op.target;
        const m = name && Object.hasOwn(membersMap, name) ? membersMap[name] : null;
        if ((m && m.killed === true) || (!m && rec.meta.existedAtDispatch)) {
          verified = true;
        }
      }
    }

    // 3. Check plan.json advancement for gate_verdict
    if (!verified && op.op === 'gate_verdict' && resolvedMeta.plan) {
      if (rec.meta.baselinePlanKey !== undefined) {
        if (resolvedMeta.planKey && resolvedMeta.planKey !== rec.meta.baselinePlanKey) {
          verified = true;
        }
      } else if (sinceMs !== null && resolvedMeta.planMtime > sinceMs) {
        verified = true;
      }
    }

    if (verified) {
      op.status = 'verified';
      op.updatedAt = nowIso;
      if (verifiedSeq !== null) op.resolvedSeq = verifiedSeq;
      op.error = null;
      dirty = true;
      continue;
    }

    // 4. Check coordinator transcript for ERROR_MESSAGE after dispatch/createdAt
    const coordErrors = Array.isArray(coordTr?.recentErrors) ? coordTr.recentErrors : [];
    let matchedErr = null;
    for (let i = coordErrors.length - 1; i >= 0; i--) {
      const e = coordErrors[i];
      if (!e) continue;
      if (sinceMs === null) {
        matchedErr = e;
        break;
      }
      if (e.ts !== null ? e.ts >= sinceMs : (coordTr?.mtime || 0) >= sinceMs) {
        matchedErr = e;
        break;
      }
    }
    if (matchedErr) {
      op.status = 'failed';
      op.updatedAt = nowIso;
      op.error = oneLine(scrubTranscriptText(matchedErr.error || 'Coordinator reported ERROR_MESSAGE'), 240);
      dirty = true;
      continue;
    }

    // 5. Transition stale unresolved ops to timed_out after 45000ms
    if (sinceMs !== null && now - sinceMs >= OPS_TIMEOUT_MS) {
      op.status = 'timed_out';
      op.updatedAt = nowIso;
      op.error = op.error || `Timed out after ${OPS_TIMEOUT_MS}ms waiting for confirmation`;
      dirty = true;
    }
  }

  let opsKey = `${opsStat.ino}:${opsStat.mtime}:${opsStat.size}`;
  if (dirty) {
    opsKey = writeOpsFileAtomic(loc.realFile, appData, swarmId, records);
  }
  return {
    ops: records.map((r) => r.publicOp),
    opsKey,
  };
}

/** Return lightweight dispatch baseline and live coordinator state for operator commands. */
export function getSwarmOpContext(appData, swarmId, now = Date.now()) {
  if (!appData || !swarmId || !ID_RE.test(swarmId)) return null;
  const dir = swarmDir(appData, swarmId);
  const roster = getSwarmRoster(appData, swarmId);
  if (!roster) return null;
  const coordinatorId = findCoordinatorConvId(roster);
  const membersMap = roster.members && typeof roster.members === 'object' ? roster.members : {};
  const coordEntry = Object.entries(membersMap).find(
    ([name, m]) => m && typeof m === 'object' && !m.killed && (roleOf(name, m) === 'coordinator' || name === 'coordinator'),
  );
  const coordinatorState = coordEntry ? getMemberLiveState(appData, coordEntry[1], now).state : 'unknown';

  const { key: baselinePlanKey } = readPlan(dir);
  const boardPath = join(dir, 'board.jsonl');
  const boardStat = statOf(boardPath);
  let baselineSeq = 0;
  if (boardStat.isFile && boardStat.size > 0) {
    const cached = boardTailCache.get(dir);
    if (
      cached &&
      cached.meta &&
      cached.meta.ino === boardStat.ino &&
      cached.meta.size === boardStat.size &&
      cached.meta.mtime === boardStat.mtime
    ) {
      baselineSeq = cached.acc?.head || 0;
    } else {
      const { parsed } = streamBoardLines(boardPath, null);
      for (const m of parsed) {
        const seq = safeSeq(m?.seq);
        if (seq > baselineSeq) baselineSeq = seq;
      }
      if (baselineSeq === 0 && parsed.length > 0) baselineSeq = parsed.length;
    }
  }

  return {
    roster,
    coordinatorId,
    coordinatorState,
    baselineSeq,
    baselinePlanKey,
  };
}

/** Read and parse `members.json` for a swarm. */
export function getSwarmRoster(appData, swarmId) {
  const mf = readSmallCached(join(swarmDir(appData, swarmId), 'members.json'), smallFileCache, 1024 * 1024);
  if (!mf.text) return null;
  return parseRoster(mf.text);
}

/** Return the coordinator conversation_id from a swarm dir, (appData, swarmId), or members roster. */
export function findCoordinatorConvId(swarmDirOrMembers, swarmId = '') {
  let roster = null;
  if (typeof swarmDirOrMembers === 'string') {
    if (swarmId) {
      roster = getSwarmRoster(swarmDirOrMembers, swarmId);
    } else {
      const mf = readSmallCached(join(swarmDirOrMembers, 'members.json'), smallFileCache, 1024 * 1024);
      if (!mf.text) return null;
      roster = parseRoster(mf.text);
    }
  } else if (Array.isArray(swarmDirOrMembers)) {
    for (const m of swarmDirOrMembers) {
      if (!m || typeof m !== 'object' || m.killed) continue;
      if ((m.role === 'coordinator' || m.name === 'coordinator') && typeof m.conversation_id === 'string' && ID_RE.test(m.conversation_id)) {
        return m.conversation_id;
      }
    }
    return null;
  } else if (swarmDirOrMembers && typeof swarmDirOrMembers === 'object') {
    roster =
      swarmDirOrMembers.members && typeof swarmDirOrMembers.members === 'object'
        ? swarmDirOrMembers
        : { members: swarmDirOrMembers };
  }
  if (!roster?.members || typeof roster.members !== 'object') return null;
  for (const [name, m] of Object.entries(roster.members)) {
    if (!m || typeof m !== 'object' || m.killed) continue;
    if ((m.role === 'coordinator' || name === 'coordinator') && typeof m.conversation_id === 'string' && ID_RE.test(m.conversation_id)) {
      return m.conversation_id;
    }
  }
  return null;
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

function buildTriageItems({ members, messages, sysAttention, ackedTriage = {}, head = 0 }) {
  const items = [];
  const memberMap = new Map(members.map((m) => [m.name, m]));

  for (const sys of sysAttention) {
    const member = memberMap.get(sys.member);
    items.push({
      id: sys.id,
      kind: sys.kind,
      severity: 'urgent',
      member: sys.member,
      conversationId: sys.conversation_id || '',
      seq: member?.lastPostSeq || 0,
      title: sys.text,
      detail: sys.detail || 'Inspect transcript and resume or switch model.',
      suggestedPrompt:
        sys.kind === 'quota'
          ? `@${sys.member} Hit quota/rate-limit on last step. Resume or switch model and continue.`
          : `@${sys.member} Last step appears ${sys.kind}. Check diagnostics and continue.`,
      timestamp: member?.transcriptMtime || 0,
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

  const ackMap = isPlainObj(ackedTriage) ? ackedTriage : {};
  for (const item of items) {
    const ack = Object.hasOwn(ackMap, item.id) ? ackMap[item.id] : null;
    if (isTriageAckActive(ack, head)) {
      item.acked = true;
      item.ackedAt = ack.at;
      if (ack.untilSeq > 0) item.ackUntilSeq = ack.untilSeq;
      if (ack.note) item.ackNote = ack.note;
    }
  }

  const order = { urgent: 0, attention: 1, verify: 2 };
  items.sort(
    (a, b) =>
      (a.acked ? 1 : 0) - (b.acked ? 1 : 0) ||
      (order[a.severity] ?? 9) - (order[b.severity] ?? 9) ||
      b.timestamp - a.timestamp,
  );
  return items;
}

// Stores ONLY compact metadata (never 2k+ message arrays or raw file strings).
const summaryMetaCache = new Map(); // `${appData}\0${id}` -> { checkedAt, membersKey, boardKey, planKey, stateKey, trStatKeys, trKeys, memberConvs, inactive, archived, etag, urgentItems, summary }
const boardTailCache = new Map(); // swarmDir -> { meta, rosterSig, acc }
const BOARD_RECENT_CAP = 64;
const BOARD_TAIL_CACHE_LIMIT = 16;
const SNAPSHOT_TRANSCRIPT_TTL_MS = 250;

/** Return diagnostic size and limit of the LRU summary metadata cache. */
export function getSummaryCacheStats() {
  return {
    size: summaryMetaCache.size,
    limit: SUMMARY_CACHE_LIMIT,
    keys: [...summaryMetaCache.keys()],
  };
}

function buildSwarmEtag({ membersKey, boardKey, title, trKeys, viewEtag, planKey, stuckKeys, opsKey, stateKey = '' }) {
  return `${membersKey}|${boardKey}|${title}|${trKeys}|${viewEtag}|${planKey}|${stuckKeys}|${opsKey}|${stateKey}`;
}

/**
 * Compute lightweight snapshot fingerprint (`etag`) + stat keys using ONLY file stats
 * and incremental transcript checks, WITHOUT reading or parsing `board.jsonl`.
 */
export function computeSwarmFingerprint(appData, id) {
  const dir = swarmDir(appData, id);
  const membersFile = readSmallCached(join(dir, 'members.json'), smallFileCache, 1024 * 1024);
  if (membersFile.text == null) return null;
  const boardStat = statOf(join(dir, 'board.jsonl'));
  const stateStat = statOf(join(dir, STATE_FILE));
  const membersKey = `${membersFile.ino}:${membersFile.mtime}:${membersFile.size}`;
  const boardKey = `${boardStat.ino}:${boardStat.mtime}:${boardStat.size}`;
  const stateKey = `${stateStat.ino}:${stateStat.mtime}:${stateStat.size}`;
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
  const { opsKey } = readOpsMeta(dir, now);
  const etag = buildSwarmEtag({
    membersKey,
    boardKey,
    title,
    trKeys,
    viewEtag: vf.etag,
    planKey,
    stuckKeys,
    opsKey,
    stateKey,
  });
  const member = roster.members ? Object.entries(roster.members).find(([, m]) => m?.conversation_id === id)?.[0] || null : null;
  return { membersKey, boardKey, stateKey, etag, member };
}

export function getSwarmMetaKeys(appData, id) {
  const dir = swarmDir(appData, id);
  const m = statOf(join(dir, 'members.json'));
  if (m.size < 0) return null;
  const b = statOf(join(dir, 'board.jsonl'));
  const p = statOf(join(dir, 'plan.json'));
  const s = statOf(join(dir, STATE_FILE));
  return {
    membersKey: `${m.ino}:${m.mtime}:${m.size}`,
    boardKey: `${b.ino}:${b.mtime}:${b.size}`,
    planKey: `${p.mtime}:${p.size}`,
    stateKey: `${s.ino}:${s.mtime}:${s.size}`,
  };
}

function scanGateTags(messages) {
  const g = { doneC: 0, doneSeq: 0, doneText: '', verC: 0, verSeq: 0, verText: '', scaleC: 0, scaleSeq: 0, scaleText: '', blkC: 0, blkSeq: 0, blkAgent: '', shipC: 0, shipSeq: 0, firstTs: 0, lastTs: 0 };
  for (const m of messages || []) {
    if (!m || m.control || !m.text) continue;
    const t = m.text;
    const hasBrk = t.indexOf('[') >= 0;
    const hasShip = t.indexOf('shipped') >= 0 || t.indexOf('Shipped') >= 0 || t.indexOf('SHIPPED') >= 0;
    if (!hasBrk && !hasShip) continue;
    const seq = Number(m.seq) || 0;
    const ts = Number(m.ts) || boardTimeMs(m.time || '') || 0;
    let hit = false;
    if (hasBrk) {
      if (/\[scale-verified\]/i.test(t)) { g.scaleC++; if (seq >= g.scaleSeq) { g.scaleSeq = seq; g.scaleText = t; } hit = true; }
      else if (/\[verified\]/i.test(t)) { g.verC++; if (seq >= g.verSeq) { g.verSeq = seq; g.verText = t; } hit = true; }
      else if (/\[done\]/i.test(t)) { g.doneC++; if (seq >= g.doneSeq) { g.doneSeq = seq; g.doneText = t; } hit = true; }
      if (/\[blocked\]/i.test(t)) { g.blkC++; if (seq >= g.blkSeq) { g.blkSeq = seq; g.blkAgent = m.agent || ''; } hit = true; }
    }
    if (hasShip && /\bshipped\b/i.test(t)) {
      g.shipC++;
      if (seq >= g.shipSeq) g.shipSeq = seq;
      hit = true;
    }
    if (hit && ts > 0) {
      if (!g.firstTs || ts < g.firstTs) g.firstTs = ts;
      if (ts > g.lastTs) g.lastTs = ts;
    }
  }
  return g;
}

/** Compute release-gate handoff progression across [done] -> [verified] -> [scale-verified] / [blocked]. */
export function computeGateReadiness(messages, triage = [], { precomputed = null, members = [], title = '' } = {}) {
  const g = precomputed || scanGateTags(messages);
  const { doneC, doneSeq, verC, verSeq, scaleC, scaleSeq, blkC, blkSeq, blkAgent } = g;
  const activeBlk = (triage || []).find((x) => !x.acked && (x.kind === 'blocked' || x.severity === 'urgent') && x.seq > 0);
  if (!doneC && !verC && !scaleC && !blkC && !g.shipC && !activeBlk) return null;
  const maxStage = Math.max(doneSeq, verSeq, scaleSeq);
  const pendingSeq = activeBlk ? activeBlk.seq
    : doneSeq > verSeq ? doneSeq
    : verSeq > scaleSeq ? verSeq
    : blkSeq > maxStage ? blkSeq
    : scaleSeq || verSeq || doneSeq || 0;
  const state = activeBlk || blkSeq > maxStage ? 'blocked'
    : scaleC > 0 && doneSeq <= verSeq && verSeq <= scaleSeq ? 'ready'
    : 'verifying';

  const pickTarget = (prefs, fallback) => {
    for (const p of prefs) {
      const hit = (members || []).find((m) => !m.killed && (m.name === p || m.name.startsWith(p)));
      if (hit) return hit;
    }
    return { name: prefs[0] || fallback, conversation_id: '' };
  };
  const ctxFrom = (text) => {
    if (!text) return '';
    const br = /Branch:\s*`?([^\s|`]+)`?/i.exec(text)?.[1];
    const cm = /Commit:\s*`?([0-9a-f]{7,40})`?/i.exec(text)?.[1]?.slice(0, 8);
    return br && cm ? ` (${br} @ ${cm})` : br ? ` (${br})` : cm ? ` (${cm})` : '';
  };

  let nextAction;
  const scope = title || 'release';
  if (state === 'blocked') {
    const tgtName = activeBlk?.member || blkAgent || 'coordinator';
    const hit = pickTarget([tgtName], tgtName);
    nextAction = {
      kind: 'unblock',
      target: hit.name,
      conversationId: activeBlk?.conversationId || hit.conversation_id || '',
      seq: pendingSeq,
      label: `Unblock @${hit.name}`,
      prompt: `@${hit.name}${pendingSeq ? ` Re #${pendingSeq}:` : ''} Resolve blocker on ${scope} and post updated [done].`,
    };
  } else if (doneSeq > verSeq) {
    const hit = pickTarget(['ux-verifier', 'verifier'], 'ux-verifier');
    nextAction = {
      kind: 'verify',
      target: hit.name,
      conversationId: hit.conversation_id || '',
      seq: doneSeq,
      label: `Nudge @${hit.name}`,
      prompt: `@${hit.name} Re #${doneSeq}: Cold-verify ${scope}${ctxFrom(g.doneText)} and post [verified].`,
    };
  } else if (verSeq > scaleSeq) {
    const hit = pickTarget(['scale-auditor', 'auditor'], 'scale-auditor');
    nextAction = {
      kind: 'scale',
      target: hit.name,
      conversationId: hit.conversation_id || '',
      seq: verSeq,
      label: `Nudge @${hit.name}`,
      prompt: `@${hit.name} Re #${verSeq}: Run cold scale/security audit on ${scope}${ctxFrom(g.verText)} and post [scale-verified].`,
    };
  } else {
    const hit = pickTarget(['release-ops', 'coordinator'], 'release-ops');
    nextAction = {
      kind: 'ship',
      target: hit.name,
      conversationId: hit.conversation_id || '',
      seq: scaleSeq || pendingSeq,
      label: `Nudge @${hit.name}`,
      prompt: `@${hit.name} Re #${scaleSeq || pendingSeq}: ${scope}${ctxFrom(g.scaleText || g.doneText)} is [scale-verified] and ready to ship.`,
    };
  }

  const okCount = doneC + verC + scaleC;
  const totalCount = okCount + blkC;
  const passRatePct = totalCount > 0 ? Math.round((okCount / totalCount) * 100) : 0;
  const waves = Math.max(g.shipC || 0, scaleC) || (verC > 0 ? verC : doneC);
  const spanMs = g.firstTs > 0 && g.lastTs > g.firstTs ? g.lastTs - g.firstTs : 0;
  const wavesPerHr = spanMs >= 60_000 ? Number(((waves * 3_600_000) / spanMs).toFixed(1)) : 0;
  const shippedSeq = g.shipSeq || scaleSeq || verSeq || doneSeq || 0;
  const exactShipped = Boolean(g.shipSeq || scaleSeq);

  return {
    state,
    pendingSeq,
    nextAction,
    velocity: {
      passRatePct,
      waves,
      wavesPerHr,
      shippedSeq,
      exactShipped,
      done: doneC,
      verified: verC,
      scaleVerified: scaleC,
      blocked: blkC,
    },
    stages: [
      { key: 'done', label: '[done]', count: doneC, seq: doneSeq },
      { key: 'verified', label: '[verified]', count: verC, seq: verSeq },
      { key: 'scale', label: '[scale-verified]', count: scaleC, seq: scaleSeq },
      { key: 'blocked', label: '[blocked]', count: blkC, seq: blkSeq },
    ],
  };
}

/** Compute per-worker cost/token share and high-burn warning state for coordinator guardrails. */
export function computeBurnSummary(members, totalTokens = 0) {
  const rawEntries = [];
  let eligibleTokenSum = 0;
  let sumInput = 0;
  let sumCacheRead = 0;
  let sumCostUsd = 0;
  let sumCacheSavingsUsd = 0;
  let anyPricingKnown = false;

  for (const m of members || []) {
    if (!m || m.roleWorker) continue;
    const u = m.usage || {};
    const inp = cleanTok(u.inputTokens);
    const cac = cleanTok(u.cacheReadTokens);
    const out = cleanTok(u.outputTokens);
    const tok = cleanTok(u.totalTokens) || inp + cac + out;

    let mCost = m.cost && typeof m.cost === 'object' ? m.cost : null;
    if (!mCost) {
      if (m.byModel && typeof m.byModel === 'object' && Object.keys(m.byModel).length > 0) {
        mCost = computeCostFromByModel(m.byModel, m.model || '');
      } else if (m.model && (inp > 0 || cac > 0 || out > 0)) {
        mCost = computeCostFromByModel({ [sanitizeModelKey(m.model)]: { inputTokens: inp, cacheReadTokens: cac, outputTokens: out, steps: 1 } }, m.model);
      }
    }

    const costUsd = roundUsd(cleanTok(mCost?.totalUsd));
    const cacheSavingsUsd = roundUsd(cleanTok(mCost?.cacheSavingsUsd));
    const pricingKnown = Boolean(mCost?.pricingKnown);
    const cacheDenom = inp + cac;
    const cacheHitPct =
      typeof mCost?.cacheHitPct === 'number' && Number.isFinite(mCost.cacheHitPct)
        ? roundPct(Math.max(0, Math.min(100, mCost.cacheHitPct)))
        : cac > 0 && cacheDenom > 0
          ? roundPct(Math.min(100, Math.max(0, (cac / cacheDenom) * 100)))
          : 0;

    if (tok <= 0 && costUsd <= 0) continue;

    eligibleTokenSum += tok;
    sumInput += inp;
    sumCacheRead += cac;
    sumCostUsd += costUsd;
    sumCacheSavingsUsd += cacheSavingsUsd;
    if (pricingKnown) anyPricingKnown = true;

    rawEntries.push({
      name: m.name,
      totalTokens: tok,
      costUsd,
      cacheHitPct,
      cacheSavingsUsd,
      pricingKnown,
      killed: Boolean(m.killed),
    });
  }

  const total = num(Number(totalTokens)) || eligibleTokenSum;
  const totalCostUsd = roundUsd(sumCostUsd);
  const totalCacheSavingsUsd = roundUsd(sumCacheSavingsUsd);
  const totalCacheHitPct =
    sumInput + sumCacheRead > 0
      ? roundPct((sumCacheRead / Math.max(1, sumInput + sumCacheRead)) * 100)
      : eligibleTokenSum > 0
        ? roundPct(rawEntries.reduce((s, r) => s + r.cacheHitPct * r.totalTokens, 0) / eligibleTokenSum)
        : 0;

  const eligibleCount = rawEntries.length;
  const multiEligible = eligibleCount >= 2;
  const rankByCost = anyPricingKnown && totalCostUsd > 0;

  const rows = rawEntries.map((r) => {
    let sharePct;
    let level;
    if (rankByCost && r.pricingKnown) {
      sharePct = totalCostUsd > 0 ? Math.round((r.costUsd / totalCostUsd) * 100) : 0;
      level =
        r.costUsd >= 5.0 || (totalCostUsd >= 0.25 && sharePct >= 65 && multiEligible)
          ? 'critical'
          : r.costUsd >= 1.5 || (totalCostUsd >= 0.10 && sharePct >= 45 && multiEligible)
            ? 'warn'
            : 'normal';
    } else if (rankByCost && !r.pricingKnown) {
      sharePct = 0;
      level =
        r.totalTokens >= 400_000 || (total >= 20_000 && (total > 0 ? Math.round((r.totalTokens / total) * 100) : 0) >= 65 && multiEligible)
          ? 'critical'
          : r.totalTokens >= 150_000 || (total >= 10_000 && (total > 0 ? Math.round((r.totalTokens / total) * 100) : 0) >= 45 && multiEligible)
            ? 'warn'
            : 'normal';
    } else {
      sharePct = total > 0 ? Math.round((r.totalTokens / total) * 100) : 0;
      level =
        r.totalTokens >= 400_000 || (total >= 20_000 && sharePct >= 65 && multiEligible)
          ? 'critical'
          : r.totalTokens >= 150_000 || (total >= 10_000 && sharePct >= 45 && multiEligible)
            ? 'warn'
            : 'normal';
    }

    return {
      name: r.name,
      totalTokens: r.totalTokens,
      sharePct,
      level,
      killed: r.killed,
      costUsd: r.costUsd,
      cacheHitPct: r.cacheHitPct,
      cacheSavingsUsd: r.cacheSavingsUsd,
      pricingKnown: r.pricingKnown,
    };
  });

  if (rankByCost) {
    rows.sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        (b.pricingKnown ? 1 : 0) - (a.pricingKnown ? 1 : 0) ||
        b.totalTokens - a.totalTokens ||
        a.name.localeCompare(b.name),
    );
  } else {
    rows.sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  }

  const topWorker = rows[0] || null;
  const highBurnCount = rows.filter((r) => r.level !== 'normal').length;
  return {
    totalTokens: total,
    costUsd: totalCostUsd,
    cacheHitPct: totalCacheHitPct,
    cacheSavingsUsd: totalCacheSavingsUsd,
    pricingKnown: anyPricingKnown,
    topWorker,
    highBurnCount,
    workers: rows.slice(0, 6),
  };
}

const REF_SEQ_RE = /(?:^|[^A-Za-z0-9_@#&])#(\d+)\b/g;

function readSwarmMeta(appData, id, now = Date.now()) {
  const dir = swarmDir(appData, id);
  const membersFile = readSmallCached(join(dir, 'members.json'), smallFileCache, 1024 * 1024);
  if (membersFile.text == null) return null;
  const boardPath = join(dir, 'board.jsonl');
  const boardStat = statOf(boardPath);
  const membersKey = `${membersFile.ino}:${membersFile.mtime}:${membersFile.size}`;
  const boardKey = `${boardStat.ino}:${boardStat.mtime}:${boardStat.size}`;

  const roster = parseRoster(membersFile.text) || { title: '', members: {} };
  const title = roster.title || id;
  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
  const rosterSig = names.map((n) => `${n}:${roleOf(n, roster.members[n])}:${isRoleWorker(n, roster.members[n]) ? 1 : 0}`).join('\0');
  const transcripts = new Map(names.map((n) => [n, summarizeTranscript(appData, roster.members[n].conversation_id)]));
  const trKeys = names.map((n) => `${n}:${transcripts.get(n).key}`).join(',');
  const narratorName = pickNarrator(roster);
  const vf = readView(appData, id, dir, narratorName ? roster.members[narratorName] : null);
  const { plan, key: planKey, mtime: planMtime } = readPlan(dir);
  const failures = new Map(names.map((n) => [n, stepFailure(transcripts.get(n).summary, now)]));
  const stuckKeys = names
    .map((n) => {
      const f = failures.get(n);
      const mt = transcripts.get(n).summary?.mtime || 0;
      return `${f ? f.kind : ''}${mt && now - mt > STUCK_MS ? 's' : ''}`;
    })
    .join(',');
  const opsMeta = readOpsMeta(dir, now);
  const stateMeta = readFleetStateMeta(dir);

  const etag = buildSwarmEtag({
    membersKey,
    boardKey,
    title,
    trKeys,
    viewEtag: vf.etag,
    planKey,
    stuckKeys,
    opsKey: opsMeta.opsKey,
    stateKey: stateMeta.stateKey,
  });
  const member = names.find((n) => roster.members[n]?.conversation_id === id) || null;
  return {
    dir,
    boardPath,
    boardStat,
    membersFile,
    membersKey,
    boardKey,
    roster,
    title,
    names,
    rosterSig,
    transcripts,
    trKeys,
    vf,
    plan,
    planKey,
    planMtime,
    stuckKeys,
    opsMeta,
    stateMeta,
    failures,
    etag,
    member,
  };
}

function createBoardAcc() {
  return {
    lineCount: 0,
    lastSeq: 0,
    head: 0,
    posts: new Map(),
    edges: new Map(),
    validSeqs: new Set(),
    replyRefsMap: new Map(),
    gateAcc: {
      doneC: 0,
      doneSeq: 0,
      doneText: '',
      verC: 0,
      verSeq: 0,
      verText: '',
      scaleC: 0,
      scaleSeq: 0,
      scaleText: '',
      blkC: 0,
      blkSeq: 0,
      blkAgent: '',
      shipC: 0,
      shipSeq: 0,
      firstTs: 0,
      lastTs: 0,
    },
    lastVerifiedSeq: 0,
    latestBlockedByAgent: new Map(),
    latestDoneByAgent: new Map(),
    channelMsgMeta: [],
    trackChannels: false,
    recentMsgs: [],
    evictedMaxSeq: 0,
  };
}

function applyBoardBatch(acc, rawObjs, roster, names, matchMentions) {
  const touchedReplyTargets = new Set();
  const touchedEdgeKeys = new Set();
  let seqReset = false;
  let sawChannelRecord = false;
  const prevLastSeq = acc.lastSeq;

  for (let i = 0; i < rawObjs.length; i++) {
    const m = rawObjs[i];
    const seq = safeSeq(m.seq);
    const agent = safeStr(m.agent);
    const text = safeStr(m.text);
    const time = safeStr(m.time);
    const ts = boardTimeMs(time);
    const channel = channelOf(m);
    const control = controlOf(m);
    m.seq = seq;
    m.agent = agent;
    m.text = text;
    m.time = time;
    m.ts = ts;
    if (channel !== MAIN) m.channel = channel;
    if (control) m.control = control;
    if (prevLastSeq > 0 && seq > 0 && seq <= prevLastSeq) seqReset = true;
    if (seq > 0 && !control) acc.validSeqs.add(seq);
    if (control || channel !== MAIN) sawChannelRecord = true;
  }

  if (seqReset) return { seqReset: true, needChannelRescan: false, touchedReplyTargets, touchedEdgeKeys };

  if (!acc.trackChannels && sawChannelRecord) {
    if (acc.lineCount > 0) {
      return { seqReset: false, needChannelRescan: true, touchedReplyTargets, touchedEdgeKeys };
    }
    acc.trackChannels = true;
  }

  let startIdx = 0;
  let byChannel = null;
  if (acc.trackChannels) {
    startIdx = acc.channelMsgMeta.length;
    for (let i = 0; i < rawObjs.length; i++) {
      const m = rawObjs[i];
      acc.channelMsgMeta.push({
        seq: m.seq,
        agent: m.agent,
        ...(m.channel ? { channel: m.channel, text: m.text } : {}),
        ...(m.control ? { control: m.control } : {}),
      });
    }
    const chReg = channelRegistry(acc.channelMsgMeta);
    byChannel = channelAddressees(roster, names, acc.channelMsgMeta, chReg);
  }

  const addReplyRef = (targetSeq, childSeq) => {
    if (targetSeq <= 0 || targetSeq === childSeq || !acc.validSeqs.has(targetSeq)) return;
    let children = acc.replyRefsMap.get(targetSeq);
    if (!children) {
      children = [];
      acc.replyRefsMap.set(targetSeq, children);
    }
    if (!children.includes(childSeq)) {
      children.push(childSeq);
      touchedReplyTargets.add(targetSeq);
    }
  };

  const seen = new Set();
  for (let i = 0; i < rawObjs.length; i++) {
    const m = rawObjs[i];
    const { seq, agent, text, time, ts, control } = m;
    acc.lineCount++;
    if (seq > acc.lastSeq) acc.lastSeq = seq;
    acc.head = acc.lastSeq || acc.lineCount;

    if (control) {
      m.mentions = [];
      m.all = false;
      acc.recentMsgs.push(m);
      continue;
    }

    if (seq > 0) {
      const explicitReply = Number(m.replyToSeq ?? m.reply_to) || 0;
      if (explicitReply > 0) addReplyRef(explicitReply, seq);
      if (text.indexOf('#') >= 0) {
        REF_SEQ_RE.lastIndex = 0;
        let match;
        while ((match = REF_SEQ_RE.exec(text)) !== null) {
          addReplyRef(Number(match[1]), seq);
        }
      }
    }

    const hasBrk = text.indexOf('[') >= 0;
    const hasShip = text.indexOf('shipped') >= 0 || text.indexOf('Shipped') >= 0 || text.indexOf('SHIPPED') >= 0;
    if (hasBrk || hasShip) {
      let hit = false;
      const g = acc.gateAcc;
      if (hasBrk) {
        if (/\[scale-verified\]/i.test(text)) { g.scaleC++; if (seq >= g.scaleSeq) { g.scaleSeq = seq; g.scaleText = text; } hit = true; }
        else if (/\[verified\]/i.test(text)) { g.verC++; if (seq >= g.verSeq) { g.verSeq = seq; g.verText = text; } hit = true; }
        else if (/\[done\]/i.test(text)) { g.doneC++; if (seq >= g.doneSeq) { g.doneSeq = seq; g.doneText = text; } hit = true; }
        if (/\[blocked\]/i.test(text)) { g.blkC++; if (seq >= g.blkSeq) { g.blkSeq = seq; g.blkAgent = agent; } hit = true; }
      }
      if (hasShip && /\bshipped\b/i.test(text)) {
        g.shipC++;
        if (seq >= g.shipSeq) g.shipSeq = seq;
        hit = true;
      }
      if (hit && ts > 0) {
        if (!g.firstTs || ts < g.firstTs) g.firstTs = ts;
        if (ts > g.lastTs) g.lastTs = ts;
      }
    }

    const trimmed = text.trim();
    if (trimmed.toLowerCase().includes('[verified]')) {
      acc.lastVerifiedSeq = Math.max(acc.lastVerifiedSeq, seq);
    }
    if (/\[blocked\]/i.test(trimmed)) {
      acc.latestBlockedByAgent.set(agent, { seq, agent, text: trimmed, ts, control: null });
    } else if (/^@\S+\s+\[done\]|\[done\]/i.test(trimmed)) {
      acc.latestDoneByAgent.set(agent, { seq, agent, text: trimmed, ts, control: null });
    }

    const { mentions, all } = matchMentions(text);
    const ch = byChannel ? byChannel(startIdx + i, text) : null;
    const viaChannel = ch ? ch.members.filter((n) => n !== agent && !mentions.includes(n)) : [];
    let p = acc.posts.get(agent);
    if (!p) {
      p = { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
      acc.posts.set(agent, p);
    }
    p.posts++;
    p.lastPostSeq = seq;
    p.lastPostTime = time;
    p.lastPostTs = ts;

    if (!isRoleWorker(agent, roster.members[agent]) && (all || mentions.length || viaChannel.length)) {
      seen.clear();
      const bumpEdge = (to, isDirect) => {
        const key = `${agent}\0${to}`;
        let e = acc.edges.get(key);
        if (!e) {
          e = { from: agent, to, count: 0, direct: 0, viaAll: 0 };
          acc.edges.set(key, e);
        }
        e.count++;
        if (isDirect) e.direct++;
        else e.viaAll++;
        touchedEdgeKeys.add(key);
      };
      if (all) {
        for (const to of names) {
          if (to === agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
          seen.add(to);
          bumpEdge(to, mentions.includes(to) || viaChannel.includes(to));
        }
      } else {
        for (const to of mentions) {
          if (to === agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
          seen.add(to);
          bumpEdge(to, true);
        }
        for (const to of viaChannel) {
          if (to === agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
          seen.add(to);
          bumpEdge(to, true);
        }
      }
    }

    m.mentions = mentions;
    m.all = all;
    if (ch?.channels.length) {
      m.channel_mentions = ch.channels;
      m.via_channel = viaChannel;
    }
    acc.recentMsgs.push(m);
  }

  return { seqReset: false, needChannelRescan: false, touchedReplyTargets, touchedEdgeKeys };
}

function trimRecentMsgs(acc) {
  while (acc.recentMsgs.length > BOARD_RECENT_CAP) {
    const oldest = acc.recentMsgs.shift();
    if (oldest && oldest.seq > acc.evictedMaxSeq) acc.evictedMaxSeq = oldest.seq;
  }
}

function buildMembersAndTelemetry(appData, id, meta, acc, now) {
  const { roster, names, transcripts, failures, title, boardStat, membersFile, vf, plan } = meta;
  const channels = acc.trackChannels ? channelRegistry(acc.channelMsgMeta) : [];
  const head = acc.head;

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  const swarmByModel = {};

  const members = names.map((name) => {
    const m = roster.members[name];
    const convId = typeof m.conversation_id === 'string' ? m.conversation_id : '';
    const last = safeSeq(m.last_read_seq);
    const tr = transcripts.get(name).summary;
    const role = roleOf(name, m);
    let unread = Math.max(0, head - last);
    let chanFields = {};
    if (channels.length) {
      const storedRole = typeof m.role === 'string' ? m.role : '';
      const rawChans = Array.isArray(m.channels) ? m.channels.filter((c) => typeof c === 'string') : null;
      const current = currentChannels(name, rawChans, acc.channelMsgMeta);
      unread = visibleUnread(name, storedRole, current, acc.channelMsgMeta, last, channels);
      chanFields = { channels: effectiveChannels(storedRole, current, name).filter((c) => typeof c === 'string') };
    }
    const tailPeek = !m.killed ? readTranscriptActivityTail(appData, convId) : null;
    const status = statusOf(m, tr);
    const activityPeek = !m.killed
      ? tailPeek
        ? {
            status: tailPeek.tool === 'swarm_wait' ? 'waiting' : status === 'killed' ? 'waiting' : status,
            label: tailPeek.label,
            tool: tailPeek.tool,
            ts: tailPeek.ts,
          }
        : tr?.activity
          ? { status, label: maskHomePath(tr.activity), tool: tr.activityKind || '', ts: tr.mtime || 0 }
          : null
      : null;
    const usage = tr?.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
    totalInputTokens += usage.inputTokens;
    totalCacheReadTokens += usage.cacheReadTokens;
    totalOutputTokens += usage.outputTokens;

    const memberModel = m.model || tr?.model || '';
    const modelSpec = getModelSpec(memberModel);
    const byModel = cloneByModel(tr?.byModel);
    if (Object.hasOwn(byModel, 'unknown') && !tr?.model && m.model) {
      const moved = byModel.unknown;
      delete byModel.unknown;
      const targetKey = sanitizeModelKey(m.model);
      if (byModel[targetKey]) {
        byModel[targetKey].inputTokens += moved.inputTokens;
        byModel[targetKey].cacheReadTokens += moved.cacheReadTokens;
        byModel[targetKey].outputTokens += moved.outputTokens;
        byModel[targetKey].steps += moved.steps;
      } else {
        byModel[targetKey] = moved;
      }
    }
    for (const [mk, mv] of Object.entries(byModel)) {
      if (!swarmByModel[mk]) {
        swarmByModel[mk] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
      }
      swarmByModel[mk].inputTokens += mv.inputTokens;
      swarmByModel[mk].cacheReadTokens += mv.cacheReadTokens;
      swarmByModel[mk].outputTokens += mv.outputTokens;
      swarmByModel[mk].steps += mv.steps;
    }

    const cost = computeCostFromByModel(byModel, memberModel);
    const lastContextTokens = tr?.lastContextTokens || 0;
    const contextLimit = modelSpec.contextLimit;
    const contextPct = computeContextPct(lastContextTokens || usage.inputTokens + usage.cacheReadTokens, contextLimit);

    return {
      name,
      conversation_id: convId,
      model: memberModel,
      role,
      wake_mode: m.wake_mode || '',
      status,
      wait_since: Number(m.wait_since) || 0,
      last_read_seq: last,
      unread,
      killed: !!m.killed,
      steps: tr?.steps || 0,
      activity: tr?.activity || '',
      activityKind: tr?.activityKind || '',
      activityPeek,
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
      lastContextTokens,
      contextLimit,
      contextPct,
      usage,
      cost,
      byModel,
      ...(typeof m.workspace_mode === 'string' && m.workspace_mode ? { workspace_mode: m.workspace_mode } : {}),
      ...(typeof m.workspace === 'string' && m.workspace ? { workspace: m.workspace } : {}),
      ...(acc.posts.get(name) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null }),
      ...chanFields,
    };
  });
  members.sort(
    (a, b) => (a.role === 'coordinator' ? 0 : 1) - (b.role === 'coordinator' ? 0 : 1) || a.name.localeCompare(b.name),
  );

  const triageMsgs = [];
  if (acc.lastVerifiedSeq > 0) {
    triageMsgs.push({ seq: acc.lastVerifiedSeq, agent: '', text: '[verified]', ts: 0, control: null });
  }
  for (const msg of acc.latestDoneByAgent.values()) triageMsgs.push(msg);
  for (const msg of acc.latestBlockedByAgent.values()) triageMsgs.push(msg);

  const fleetState = meta.stateMeta?.state || emptyFleetState();
  const sysAttention = systemAttention(members, now);
  const triage = buildTriageItems({
    members,
    messages: triageMsgs,
    sysAttention,
    ackedTriage: fleetState.ackedTriage,
    head,
  });
  const totalTokens = totalInputTokens + totalCacheReadTokens + totalOutputTokens;
  const burnSummary = computeBurnSummary(members, totalTokens);
  const gateReadiness = computeGateReadiness(triageMsgs, triage, { precomputed: acc.gateAcc, members, title });
  const cost = computeCostFromByModel(swarmByModel);
  if (!Object.keys(swarmByModel).length && members.some((m) => m.cost?.pricingKnown)) {
    cost.pricingKnown = true;
  }

  let contextLimit = 200_000;
  let contextPct = 0;
  const liveMembers = members.filter((m) => !m.killed);
  const ctxPool = liveMembers.length > 0 ? liveMembers : members;
  if (ctxPool.length > 0) {
    let peak = ctxPool[0];
    for (let i = 1; i < ctxPool.length; i++) {
      if (ctxPool[i].contextPct > peak.contextPct) peak = ctxPool[i];
    }
    contextLimit = peak.contextLimit;
    contextPct = peak.contextPct;
  }

  const lastActivityTs = Math.max(boardStat.mtime || 0, membersFile.mtime || 0, ...members.map((m) => m.transcriptMtime || 0));
  const memberConvs = members.map((m) => m.conversation_id).filter(Boolean);
  const trStatKeys = computeTranscriptStatKeys(appData, memberConvs);

  cacheSwarmSummary({
    appData,
    id,
    now,
    membersKey: meta.membersKey,
    boardKey: meta.boardKey,
    planKey: meta.planKey,
    stateKey: meta.stateMeta?.stateKey || '0:0:-1',
    trKeys: meta.trKeys,
    trStatKeys,
    memberConvs,
    etag: meta.etag,
    title,
    head,
    members,
    triage,
    totalTokens,
    cost,
    gateReadiness,
    plan,
    fleetState,
    lastActivityTs,
  });

  return {
    members,
    channels,
    sysAttention,
    triage,
    pinnedSeqs: fleetState.pinnedSeqs,
    ackedTriage: fleetState.ackedTriage,
    archived: fleetState.archived,
    burnSummary,
    gateReadiness,
    contextLimit,
    contextPct,
    cost,
    byModel: swarmByModel,
    usage: {
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
    },
    view: vf.view,
    plan,
  };
}

function computeTranscriptStatKeys(appData, memberConvs) {
  return memberConvs
    .map((cid) => {
      const s = statOf(transcriptPath(appData, cid));
      return `${cid}:${s.ino}:${s.mtime}:${s.size}`;
    })
    .join(',');
}

function buildSwarmSummaryRecord({
  appData,
  id,
  title,
  head,
  members,
  triage,
  totalTokens,
  cost,
  gateReadiness,
  plan,
  fleetState,
  lastActivityTs,
}) {
  const activeCount = members.filter((m) => !m.killed && m.status === 'working').length;
  const waitingCount = members.filter((m) => !m.killed && m.status === 'waiting').length;
  const killedCount = members.filter((m) => m.killed).length;
  const unackedTriage = triage.filter((t) => !t.acked);
  const urgentItems = unackedTriage.filter((t) => t.severity === 'urgent');
  const blockedCount = unackedTriage.filter((t) => t.kind === 'blocked').length;
  const failureCount = unackedTriage.filter((t) => t.kind === 'quota' || t.kind === 'error').length;
  const archived = Boolean(fleetState?.archived);

  return {
    summary: {
      id,
      title,
      appData,
      head,
      memberCount: members.length,
      activeCount,
      waitingCount,
      killedCount,
      triageCount: unackedTriage.length,
      urgentCount: urgentItems.length,
      blockedCount,
      failureCount,
      totalTokens,
      costUsd: roundUsd(cleanTok(cost?.totalUsd)),
      gateState: gateReadiness?.state || null,
      repo: plan?.repo || '',
      archived,
      topUrgent: urgentItems[0] || null,
      hasPlan: Boolean(plan),
      lastActivityTs,
    },
    urgentItems,
    activeCount,
    archived,
  };
}

function cacheSwarmSummary(opts) {
  const rec = buildSwarmSummaryRecord(opts);
  const inactive = rec.archived || (rec.activeCount === 0 && opts.now - opts.lastActivityTs > INACTIVE_SWARM_MS);
  const entry = {
    checkedAt: opts.now,
    membersKey: opts.membersKey,
    boardKey: opts.boardKey,
    planKey: opts.planKey,
    stateKey: opts.stateKey,
    trKeys: opts.trKeys,
    trStatKeys: opts.trStatKeys,
    memberConvs: opts.memberConvs,
    inactive,
    archived: rec.archived,
    etag: opts.etag || '',
    urgentItems: rec.urgentItems,
    summary: rec.summary,
  };
  lruSet(summaryMetaCache, `${opts.appData}\0${opts.id}`, entry, SUMMARY_CACHE_LIMIT);
  return entry;
}

function buildSwarmSummaryOnly(appData, id, now = Date.now()) {
  const dir = swarmDir(appData, id);
  const membersFile = readSmallCached(join(dir, 'members.json'), smallFileCache, 1024 * 1024);
  if (membersFile.text == null) return null;
  const boardPath = join(dir, 'board.jsonl');
  const boardStat = statOf(boardPath);
  const membersKey = `${membersFile.ino}:${membersFile.mtime}:${membersFile.size}`;
  const boardKey = `${boardStat.ino}:${boardStat.mtime}:${boardStat.size}`;
  const roster = parseRoster(membersFile.text) || { title: '', members: {} };
  const title = roster.title || id;
  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
  const { plan, key: planKey } = readPlan(dir);
  const stateMeta = readFleetStateMeta(dir);
  const fleetState = stateMeta.state;

  let head = 0;
  let lineCount = 0;
  let lastVerifiedSeq = 0;
  const posts = new Map();
  const latestBlockedByAgent = new Map();
  const latestDoneByAgent = new Map();
  const gateAcc = {
    doneC: 0,
    doneSeq: 0,
    doneText: '',
    verC: 0,
    verSeq: 0,
    verText: '',
    scaleC: 0,
    scaleSeq: 0,
    scaleText: '',
    blkC: 0,
    blkSeq: 0,
    blkAgent: '',
    shipC: 0,
    shipSeq: 0,
    firstTs: 0,
    lastTs: 0,
  };

  if (boardStat.isFile && boardStat.size > 0) {
    streamLinesIncremental(
      boardPath,
      null,
      () => {
        head = 0;
        lineCount = 0;
        lastVerifiedSeq = 0;
        posts.clear();
        latestBlockedByAgent.clear();
        latestDoneByAgent.clear();
      },
      (line, preParsed) => {
        let m = preParsed;
        if (!m) {
          try {
            m = JSON.parse(line);
          } catch {
            return;
          }
        }
        if (!m || typeof m !== 'object' || Array.isArray(m)) return;
        lineCount++;
        const seq = safeSeq(m.seq);
        if (seq > head) head = seq;
        if (controlOf(m)) return;
        const agent = safeStr(m.agent);
        const text = safeStr(m.text);
        const ts = boardTimeMs(safeStr(m.time));

        if (agent) {
          let p = posts.get(agent);
          if (!p) {
            p = { lastPostSeq: 0, lastPostTs: null };
            posts.set(agent, p);
          }
          p.lastPostSeq = seq;
          p.lastPostTs = ts;
        }

        const hasBrk = text.indexOf('[') >= 0;
        const hasShip = text.indexOf('shipped') >= 0 || text.indexOf('Shipped') >= 0 || text.indexOf('SHIPPED') >= 0;
        if (hasBrk || hasShip) {
          let hit = false;
          if (hasBrk) {
            if (/\[scale-verified\]/i.test(text)) { gateAcc.scaleC++; if (seq >= gateAcc.scaleSeq) { gateAcc.scaleSeq = seq; gateAcc.scaleText = text; } hit = true; }
            else if (/\[verified\]/i.test(text)) { gateAcc.verC++; if (seq >= gateAcc.verSeq) { gateAcc.verSeq = seq; gateAcc.verText = text; } hit = true; }
            else if (/\[done\]/i.test(text)) { gateAcc.doneC++; if (seq >= gateAcc.doneSeq) { gateAcc.doneSeq = seq; gateAcc.doneText = text; } hit = true; }
            if (/\[blocked\]/i.test(text)) { gateAcc.blkC++; if (seq >= gateAcc.blkSeq) { gateAcc.blkSeq = seq; gateAcc.blkAgent = agent; } hit = true; }
          }
          if (hasShip && /\bshipped\b/i.test(text)) {
            gateAcc.shipC++;
            if (seq >= gateAcc.shipSeq) gateAcc.shipSeq = seq;
            hit = true;
          }
          if (hit && ts > 0) {
            if (!gateAcc.firstTs || ts < gateAcc.firstTs) gateAcc.firstTs = ts;
            if (ts > gateAcc.lastTs) gateAcc.lastTs = ts;
          }
        }

        const trimmed = text.trim();
        if (trimmed.toLowerCase().includes('[verified]')) {
          lastVerifiedSeq = Math.max(lastVerifiedSeq, seq);
        }
        if (/\[blocked\]/i.test(trimmed)) {
          latestBlockedByAgent.set(agent, { seq, agent, text: trimmed, ts, control: null });
        } else if (/^@\S+\s+\[done\]|\[done\]/i.test(trimmed)) {
          latestDoneByAgent.set(agent, { seq, agent, text: trimmed, ts, control: null });
        }
      },
    );
    if (head === 0 && lineCount > 0) head = lineCount;
  }

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  const swarmByModel = {};
  const trKeysArr = [];
  const memberConvs = [];

  const members = names.map((name) => {
    const m = roster.members[name];
    const convId = typeof m.conversation_id === 'string' ? m.conversation_id : '';
    if (convId) memberConvs.push(convId);
    const trRes = summarizeTranscript(appData, convId);
    trKeysArr.push(`${name}:${trRes.key}`);
    const tr = trRes.summary;
    const role = roleOf(name, m);
    const status = statusOf(m, tr);
    const failure = stepFailure(tr, now);
    const usage = tr?.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
    totalInputTokens += usage.inputTokens;
    totalCacheReadTokens += usage.cacheReadTokens;
    totalOutputTokens += usage.outputTokens;

    const memberModel = m.model || tr?.model || '';
    const byModel = cloneByModel(tr?.byModel);
    if (Object.hasOwn(byModel, 'unknown') && !tr?.model && m.model) {
      const moved = byModel.unknown;
      delete byModel.unknown;
      const targetKey = sanitizeModelKey(m.model);
      if (byModel[targetKey]) {
        byModel[targetKey].inputTokens += moved.inputTokens;
        byModel[targetKey].cacheReadTokens += moved.cacheReadTokens;
        byModel[targetKey].outputTokens += moved.outputTokens;
        byModel[targetKey].steps += moved.steps;
      } else {
        byModel[targetKey] = moved;
      }
    }
    for (const [mk, mv] of Object.entries(byModel)) {
      if (!swarmByModel[mk]) {
        swarmByModel[mk] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
      }
      swarmByModel[mk].inputTokens += mv.inputTokens;
      swarmByModel[mk].cacheReadTokens += mv.cacheReadTokens;
      swarmByModel[mk].outputTokens += mv.outputTokens;
      swarmByModel[mk].steps += mv.steps;
    }

    const cost = computeCostFromByModel(byModel, memberModel);
    return {
      name,
      conversation_id: convId,
      model: memberModel,
      role,
      status,
      killed: !!m.killed,
      steps: tr?.steps || 0,
      replyAsk: tr?.replyAsk || '',
      narrator: narratorRank(name, m) >= 0,
      roleWorker: isRoleWorker(name, m),
      failure,
      transcriptMtime: tr?.mtime || 0,
      cost,
      ...(posts.get(name) || { lastPostSeq: 0, lastPostTs: null }),
    };
  });
  members.sort(
    (a, b) => (a.role === 'coordinator' ? 0 : 1) - (b.role === 'coordinator' ? 0 : 1) || a.name.localeCompare(b.name),
  );

  const triageMsgs = [];
  if (lastVerifiedSeq > 0) {
    triageMsgs.push({ seq: lastVerifiedSeq, agent: '', text: '[verified]', ts: 0, control: null });
  }
  for (const msg of latestDoneByAgent.values()) triageMsgs.push(msg);
  for (const msg of latestBlockedByAgent.values()) triageMsgs.push(msg);

  const sysAttention = systemAttention(members, now);
  const triage = buildTriageItems({
    members,
    messages: triageMsgs,
    sysAttention,
    ackedTriage: fleetState.ackedTriage,
    head,
  });
  const totalTokens = totalInputTokens + totalCacheReadTokens + totalOutputTokens;
  const gateReadiness = computeGateReadiness(triageMsgs, triage, { precomputed: gateAcc, members, title });
  const cost = computeCostFromByModel(swarmByModel);
  if (!Object.keys(swarmByModel).length && members.some((m) => m.cost?.pricingKnown)) {
    cost.pricingKnown = true;
  }
  const lastActivityTs = Math.max(boardStat.mtime || 0, membersFile.mtime || 0, ...members.map((m) => m.transcriptMtime || 0));

  return cacheSwarmSummary({
    appData,
    id,
    now,
    membersKey,
    boardKey,
    planKey,
    stateKey: stateMeta.stateKey,
    trKeys: trKeysArr.join(','),
    trStatKeys: computeTranscriptStatKeys(appData, memberConvs),
    memberConvs,
    etag: '',
    title,
    head,
    members,
    triage,
    totalTokens,
    cost,
    gateReadiness,
    plan,
    fleetState,
    lastActivityTs,
  });
}

function streamBoardLines(boardPath, prevMeta) {
  const parsed = [];
  let wasReset = !prevMeta;
  const res = streamLinesIncremental(
    boardPath,
    prevMeta,
    () => {
      wasReset = true;
      parsed.length = 0;
    },
    (line, preParsed) => {
      if (preParsed) {
        parsed.push(preParsed);
        return;
      }
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed.push(obj);
      } catch {
        // ignore torn line
      }
    },
  );
  return { res, parsed, wasReset };
}

/**
 * Build full snapshot of a swarm WITHOUT retaining large message arrays in JS heap cache.
 * Stores compact swarm summary in `summaryMetaCache` for `listSwarms()`.
 */
export function buildSwarmSnapshot(appData, id, { includeRaw = false } = {}) {
  const cacheKey = `${appData}\0${id}`;
  const now = Date.now();
  const meta = readSwarmMeta(appData, id, now);
  if (!meta) {
    summaryMetaCache.delete(cacheKey);
    boardTailCache.delete(swarmDir(appData, id));
    return null;
  }

  const { dir, boardPath, boardStat, membersFile, roster, title, names, rosterSig, vf } = meta;
  const allowedFiles = allowedFilesOf(appData, vf.view.json);
  const { res, parsed: msgs } = boardStat.size > 0 ? streamBoardLines(boardPath, null) : { res: { exists: false, meta: null }, parsed: [] };
  const frames = postedFrames(roster, msgs);
  const matchMentions = createMentionsMatcher(names);
  const acc = createBoardAcc();
  applyBoardBatch(acc, msgs, roster, names, matchMentions);

  const { ops, opsKey } = reconcileOperatorOps(appData, id, { meta, messages: msgs, now });
  const etag = buildSwarmEtag({
    membersKey: meta.membersKey,
    boardKey: meta.boardKey,
    title,
    trKeys: meta.trKeys,
    viewEtag: vf.etag,
    planKey: meta.planKey,
    stuckKeys: meta.stuckKeys,
    opsKey,
    stateKey: meta.stateMeta?.stateKey || '',
  });
  meta.etag = etag;

  const telemetry = buildMembersAndTelemetry(appData, id, meta, acc, now);

  const replyRefs = {};
  for (const [targetSeq, children] of acc.replyRefsMap.entries()) {
    children.sort((a, b) => a - b);
    replyRefs[targetSeq] = children;
  }
  const edges = [...acc.edges.values()];

  // Retain only bounded tail state in boardTailCache (never full 2k+ message arrays)
  trimRecentMsgs(acc);
  lruSet(boardTailCache, dir, { meta: res.meta, rosterSig, acc }, BOARD_TAIL_CACHE_LIMIT);

  const snap = {
    id,
    title,
    appData,
    dir,
    etag,
    head: acc.head,
    members: telemetry.members,
    messages: msgs,
    replyRefs,
    ...(telemetry.channels.length ? { channels: telemetry.channels } : {}),
    edges,
    view: telemetry.view,
    plan: telemetry.plan,
    ops,
    frames,
    allowedFiles,
    systemAttention: telemetry.sysAttention,
    triage: telemetry.triage,
    pinnedSeqs: telemetry.pinnedSeqs,
    ackedTriage: telemetry.ackedTriage,
    archived: telemetry.archived,
    burnSummary: telemetry.burnSummary,
    gateReadiness: telemetry.gateReadiness,
    contextLimit: telemetry.contextLimit,
    contextPct: telemetry.contextPct,
    cost: telemetry.cost,
    byModel: telemetry.byModel,
    usage: telemetry.usage,
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

/** Return cached incremental board tail metadata for diagnostics/tests. */
export function getBoardTailStats(appData, id) {
  const entry = boardTailCache.get(swarmDir(appData, id));
  if (!entry) return null;
  return {
    ino: entry.meta?.ino || 0,
    size: entry.meta?.size ?? -1,
    mtime: entry.meta?.mtime || 0,
    head: entry.acc.head,
    lineCount: entry.acc.lineCount,
    recentCount: entry.acc.recentMsgs.length,
    evictedMaxSeq: entry.acc.evictedMaxSeq,
  };
}

/**
 * Build incremental swarm delta or full snapshot using byte-offset `board.jsonl` tail caching.
 */
export function buildSwarmDelta({ appData, conversationId, since = 0, prevEtag = '' } = {}) {
  if (!appData || typeof conversationId !== 'string' || !ID_RE.test(conversationId)) return null;

  let swarmId = conversationId;
  let resolvedMember = null;
  let now = Date.now();
  let meta = readSwarmMeta(appData, swarmId, now);
  if (!meta) {
    const resolved = resolveConversationSwarm([appData], conversationId);
    if (!resolved.swarm || !resolved.appData) return null;
    swarmId = resolved.swarm;
    resolvedMember = resolved.member;
    meta = readSwarmMeta(appData, swarmId, now);
    if (!meta) return null;
  } else {
    resolvedMember = meta.member;
  }

  const { dir, boardPath, boardStat, roster, names, rosterSig, etag } = meta;
  const fullCompositeEtag = `${swarmId}|${resolvedMember || ''}|${etag}`;
  const etagMatched = Boolean(prevEtag && (prevEtag === etag || prevEtag === fullCompositeEtag));

  const sinceNum = Number.isSafeInteger(Number(since)) && Number(since) > 0 ? Number(since) : 0;
  let cached = boardTailCache.get(dir);
  const canUseCachedTail = Boolean(
    cached &&
    cached.rosterSig === rosterSig &&
    cached.meta &&
    boardStat.isFile &&
    boardStat.ino === cached.meta.ino &&
    boardStat.size >= cached.meta.size,
  );

  if (etagMatched) {
    if (canUseCachedTail && cached.meta.mtime === boardStat.mtime && cached.meta.size === boardStat.size) {
      return {
        ok: true,
        unchanged: true,
        conversationId,
        swarm: swarmId,
        member: resolvedMember,
        etag,
        head: cached.acc.head,
      };
    }
    if (!boardStat.isFile || boardStat.size <= 0) {
      return {
        ok: true,
        unchanged: true,
        conversationId,
        swarm: swarmId,
        member: resolvedMember,
        etag,
        head: 0,
      };
    }
    // Cold cache with matching etag: populate tail cache once to obtain exact head
    const snap = buildSwarmSnapshot(appData, swarmId);
    if (!snap) return null;
    return {
      ok: true,
      unchanged: true,
      conversationId,
      swarm: swarmId,
      member: resolvedMember,
      etag: snap.etag,
      head: snap.head,
    };
  }

  const returnFull = () => {
    const snap = buildSwarmSnapshot(appData, swarmId);
    if (!snap) return null;
    return {
      ok: true,
      mode: 'full',
      unchanged: false,
      conversationId,
      swarm: swarmId,
      member: resolvedMember,
      ...snap,
    };
  };

  if (sinceNum <= 0) {
    return returnFull();
  }

  // Detect file deletion, rotation, or truncation against cached tail state
  if (cached && (!boardStat.isFile || !cached.meta || boardStat.ino !== cached.meta.ino || boardStat.size < cached.meta.size)) {
    return returnFull();
  }

  const matchMentions = createMentionsMatcher(names);
  let acc;
  let prevEvictedMaxSeq = 0;
  let batchResult = { seqReset: false, needChannelRescan: false, touchedReplyTargets: new Set(), touchedEdgeKeys: new Set() };
  let streamMeta = null;

  if (canUseCachedTail) {
    acc = cached.acc;
    prevEvictedMaxSeq = acc.evictedMaxSeq;
    if (boardStat.size === cached.meta.size && boardStat.mtime === cached.meta.mtime) {
      streamMeta = cached.meta;
    } else {
      const { res, parsed, wasReset } = streamBoardLines(boardPath, cached.meta);
      if (wasReset || !res.exists) return returnFull();
      streamMeta = res.meta;
      if (parsed.length > 0) {
        batchResult = applyBoardBatch(acc, parsed, roster, names, matchMentions);
        if (batchResult.seqReset || batchResult.needChannelRescan) return returnFull();
      }
    }
  } else {
    if (boardStat.size <= 0) return returnFull();
    const { res, parsed } = streamBoardLines(boardPath, null);
    if (!res.exists) return returnFull();
    streamMeta = res.meta;
    acc = createBoardAcc();
    batchResult = applyBoardBatch(acc, parsed, roster, names, matchMentions);
    if (batchResult.seqReset) return returnFull();
    trimRecentMsgs(acc);
    prevEvictedMaxSeq = acc.evictedMaxSeq;
  }

  // If client's since is ahead of board head or older than retained recent window, fall back to full snapshot
  if (sinceNum > acc.head || sinceNum < prevEvictedMaxSeq) {
    trimRecentMsgs(acc);
    lruSet(boardTailCache, dir, { meta: streamMeta, rosterSig, acc }, BOARD_TAIL_CACHE_LIMIT);
    return returnFull();
  }

  const messagesDelta = acc.recentMsgs.filter((m) => m.seq > sinceNum);
  const replyRefsDelta = {};
  const deltaEdgesMap = new Map();
  if (messagesDelta.length > 0) {
    const seen = new Set();
    for (const m of messagesDelta) {
      if (m.control || m.seq <= 0) continue;
      const explicitReply = Number(m.replyToSeq ?? m.reply_to) || 0;
      if (explicitReply > 0 && acc.replyRefsMap.has(explicitReply)) {
        replyRefsDelta[explicitReply] = acc.replyRefsMap.get(explicitReply).slice().sort((a, b) => a - b);
      }
      if (m.text.indexOf('#') >= 0) {
        REF_SEQ_RE.lastIndex = 0;
        let match;
        while ((match = REF_SEQ_RE.exec(m.text)) !== null) {
          const t = Number(match[1]);
          if (acc.replyRefsMap.has(t)) replyRefsDelta[t] = acc.replyRefsMap.get(t).slice().sort((a, b) => a - b);
        }
      }
      const mentions = m.mentions || [];
      const viaChannel = m.via_channel || [];
      if (!isRoleWorker(m.agent, roster.members[m.agent]) && (m.all || mentions.length || viaChannel.length)) {
        seen.clear();
        const bumpDeltaEdge = (to, isDirect) => {
          const key = `${m.agent}\0${to}`;
          let e = deltaEdgesMap.get(key);
          if (!e) {
            e = { from: m.agent, to, count: 0, direct: 0, viaAll: 0 };
            deltaEdgesMap.set(key, e);
          }
          e.count++;
          if (isDirect) e.direct++;
          else e.viaAll++;
        };
        if (m.all) {
          for (const to of names) {
            if (to === m.agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
            seen.add(to);
            bumpDeltaEdge(to, mentions.includes(to) || viaChannel.includes(to));
          }
        } else {
          for (const to of mentions) {
            if (to === m.agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
            seen.add(to);
            bumpDeltaEdge(to, true);
          }
          for (const to of viaChannel) {
            if (to === m.agent || isRoleWorker(to, roster.members[to]) || seen.has(to)) continue;
            seen.add(to);
            bumpDeltaEdge(to, true);
          }
        }
      }
    }
  }
  const edgesDelta = [...deltaEdgesMap.values()];

  trimRecentMsgs(acc);
  lruSet(boardTailCache, dir, { meta: streamMeta, rosterSig, acc }, BOARD_TAIL_CACHE_LIMIT);

  const { ops, opsKey } = reconcileOperatorOps(appData, swarmId, { meta, messages: acc.recentMsgs, now });
  const finalEtag = buildSwarmEtag({
    membersKey: meta.membersKey,
    boardKey: meta.boardKey,
    title: meta.title,
    trKeys: meta.trKeys,
    viewEtag: meta.vf.etag,
    planKey: meta.planKey,
    stuckKeys: meta.stuckKeys,
    opsKey,
    stateKey: meta.stateMeta?.stateKey || '',
  });
  meta.etag = finalEtag;

  const telemetry = buildMembersAndTelemetry(appData, swarmId, meta, acc, now);

  return {
    ok: true,
    mode: 'delta',
    unchanged: false,
    conversationId,
    swarm: swarmId,
    member: resolvedMember,
    etag: finalEtag,
    since: sinceNum,
    head: acc.head,
    messagesDelta,
    replyRefsDelta,
    edgesDelta,
    members: telemetry.members,
    ...(telemetry.channels.length ? { channels: telemetry.channels } : {}),
    plan: telemetry.plan,
    ops,
    view: telemetry.view,
    triage: telemetry.triage,
    pinnedSeqs: telemetry.pinnedSeqs,
    ackedTriage: telemetry.ackedTriage,
    archived: telemetry.archived,
    burnSummary: telemetry.burnSummary,
    gateReadiness: telemetry.gateReadiness,
    contextLimit: telemetry.contextLimit,
    contextPct: telemetry.contextPct,
    cost: telemetry.cost,
    byModel: telemetry.byModel,
    usage: telemetry.usage,
  };
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
  lruSet(swarmIdsScanCache, rootKey, { at: now, entries }, 16);
  return entries;
}

/** Resolve which swarm a conversation belongs to (coordinator dir or member roster). */
export function resolveConversationSwarm(appDataDirs, conv) {
  if (typeof conv !== 'string' || !conv || !ID_RE.test(conv)) return { appData: null, swarm: null, member: null };
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

/** Scan all available local swarms using LRU=64 cached lightweight summary metadata (stat-only on warm hits). */
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
    if (
      hit &&
      hit.membersKey === keys.membersKey &&
      hit.boardKey === keys.boardKey &&
      hit.planKey === keys.planKey &&
      hit.stateKey === keys.stateKey
    ) {
      lruSet(summaryMetaCache, cacheKey, hit, SUMMARY_CACHE_LIMIT);
      if (now - hit.checkedAt < SNAPSHOT_TRANSCRIPT_TTL_MS) {
        list.push(hit.summary);
        continue;
      }
      if ((hit.archived || hit.inactive) && now - hit.checkedAt < 10_000) {
        list.push(hit.summary);
        continue;
      }
      const curTrStatKeys = computeTranscriptStatKeys(appData, hit.memberConvs || []);
      if (curTrStatKeys === hit.trStatKeys) {
        hit.checkedAt = now;
        list.push(hit.summary);
        continue;
      }
    }

    if (onSnapshot) {
      const stateMeta = readFleetStateMeta(swarmDir(appData, id));
      if (!stateMeta.state.archived) {
        const snap = buildSwarmSnapshot(appData, id);
        if (!snap) continue;
        onSnapshot(appData, id, snap, keys);
        const entry = summaryMetaCache.get(cacheKey);
        if (entry) list.push(entry.summary);
        continue;
      }
    }

    const entry = buildSwarmSummaryOnly(appData, id, now);
    if (entry) list.push(entry.summary);
  }
  list.sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || b.activeCount - a.activeCount || b.lastActivityTs - a.lastActivityTs);
  return list;
}

/** Build multi-swarm portfolio rollup with aggregated cost, tokens, active count, and urgent triage queue. */
export function getPortfolio(appDataDirs) {
  const swarms = listSwarms(appDataDirs);
  let totalCostUsd = 0;
  let totalTokens = 0;
  let activeSwarms = 0;
  const urgentTriage = [];

  for (const s of swarms) {
    if (s.archived) continue;
    activeSwarms++;
    totalCostUsd += cleanTok(s.costUsd);
    totalTokens += cleanTok(s.totalTokens);
    const cacheKey = `${s.appData}\0${s.id}`;
    const entry = summaryMetaCache.get(cacheKey);
    const urgents = entry?.urgentItems || (s.topUrgent ? [s.topUrgent] : []);
    for (const item of urgents) {
      urgentTriage.push({
        ...item,
        swarmId: s.id,
        swarmTitle: s.title,
      });
    }
  }

  urgentTriage.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return {
    totalCostUsd: roundUsd(totalCostUsd),
    totalTokens,
    activeSwarms,
    urgentCount: urgentTriage.length,
    urgentTriage,
    swarms,
  };
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

const TRANSCRIPT_PAGE_SCAN_BYTES = 512 * 1024;
const TRANSCRIPT_BACK_CHUNK_BYTES = 64 * 1024;
const TRANSCRIPT_TEXT_MAX_CHARS = 1200;
const TRANSCRIPT_PREVIEW_MAX_BYTES = 2048;

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const AUTH_HDR_RE = /\b(Authorization:\s*(?:Basic|Token|Bearer)\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
const BEARER_PROSE_WORDS = new Set([
  'token',
  'tokens',
  'auth',
  'authentication',
  'authorization',
  'header',
  'headers',
  'scheme',
  'schemes',
  'format',
  'formats',
  'credential',
  'credentials',
  'flow',
  'flows',
  'mode',
  'modes',
  'type',
  'types',
  'prefix',
  'prefixes',
  'access',
  'grant',
  'grants',
  'client',
  'clients',
  'server',
  'servers',
  'string',
  'strings',
  'value',
  'values',
  'should',
  'must',
  'will',
  'would',
  'could',
  'shall',
  'cannot',
  'present',
  'missing',
]);
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{4,})/g;
const SK_TOKEN_RE = /\bsk-(?:proj-|ant-|svcacct-|live-|test-)[A-Za-z0-9_-]{4,}|\bsk-(?=[A-Za-z0-9_-]*[0-9A-Z_])[A-Za-z0-9_-]{4,}|\bsk-[A-Za-z0-9_-]{10,}/g;
const GH_TOKEN_RE = /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{4,}|\bgithub_pat_[A-Za-z0-9_]{4,}/g;
const AIZA_TOKEN_RE = /\bAIza[A-Za-z0-9_-]{4,}/g;
const SLACK_TOKEN_RE = /\bxox[bpaers]-[A-Za-z0-9-]{4,}/g;
const AWS_TOKEN_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{4,}/g;
const ENV_SECRET_RE = /\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|BOT_TOKEN|PRIVATE_KEY|PASSWORD|SECRET|TOKEN)\s*=\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'`;,]{6,})/g;

const transcriptCursorCache = new Map(); // realPath -> { ino, size, anchors: Map<stepIndex, byteOffset> }

function scrubTranscriptText(s) {
  if (s === undefined || s === null) return '';
  const out = maskHomePath(safeStr(s));
  if (!out) return '';
  return out
    .replace(PRIVATE_KEY_RE, '[REDACTED:PRIVATE_KEY]')
    .replace(AUTH_HDR_RE, '$1[REDACTED]')
    .replace(BEARER_RE, (full, prefix, tok) => {
      if (BEARER_PROSE_WORDS.has(tok.toLowerCase())) return full;
      if (/[0-9._~+/=-]/.test(tok) || (/[A-Z]/.test(tok) && /[a-z]/.test(tok)) || tok.length >= 16) {
        return `${prefix}[REDACTED]`;
      }
      return full;
    })
    .replace(SK_TOKEN_RE, '[REDACTED:sk]')
    .replace(GH_TOKEN_RE, '[REDACTED:github]')
    .replace(AIZA_TOKEN_RE, '[REDACTED:AIza]')
    .replace(SLACK_TOKEN_RE, '[REDACTED:slack]')
    .replace(AWS_TOKEN_RE, '[REDACTED:AWS]')
    .replace(ENV_SECRET_RE, '$1[REDACTED]');
}

function truncateChars(s, maxChars = TRANSCRIPT_TEXT_MAX_CHARS) {
  if (!s || s.length <= maxChars) return s;
  let end = Math.max(0, maxChars - 1);
  if (end > 0) {
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return `${s.slice(0, end)}…`;
}

function truncateUtf8Bytes(s, maxBytes = TRANSCRIPT_PREVIEW_MAX_BYTES) {
  if (!s) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const suffix = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  const buf = Buffer.from(s, 'utf8');
  let end = Math.min(budget, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return `${buf.toString('utf8', 0, end)}${suffix}`;
}

function scrubValue(val, depth = 0, strCap = 0) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const scrubbed = scrubTranscriptText(val);
    return strCap > 0 ? truncateUtf8Bytes(scrubbed, strCap) : scrubbed;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(val)) {
    const cap = Math.min(val.length, 50);
    const arr = [];
    for (let i = 0; i < cap; i++) arr.push(scrubValue(val[i], depth + 1, strCap));
    if (val.length > cap) arr.push(`…(+${val.length - cap})`);
    return arr;
  }
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = scrubValue(v, depth + 1, strCap);
    }
    return out;
  }
  return safeStr(val);
}

function scrubAndBoundArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return {};
  if (typeof rawArgs === 'string') {
    return truncateUtf8Bytes(scrubTranscriptText(rawArgs), TRANSCRIPT_PREVIEW_MAX_BYTES);
  }
  if (typeof rawArgs !== 'object') return {};
  const scrubbed = scrubValue(rawArgs, 0, 0);
  let json = '';
  try {
    json = JSON.stringify(scrubbed) || '{}';
  } catch {
    return {};
  }
  if (Buffer.byteLength(json, 'utf8') <= TRANSCRIPT_PREVIEW_MAX_BYTES) return scrubbed;
  if (!Array.isArray(scrubbed)) {
    const trimmed = scrubValue(rawArgs, 0, 256);
    trimmed._truncated = true;
    try {
      const tj = JSON.stringify(trimmed) || '{}';
      if (Buffer.byteLength(tj, 'utf8') <= TRANSCRIPT_PREVIEW_MAX_BYTES) return trimmed;
    } catch {}
  }
  return { _truncated: true, preview: truncateUtf8Bytes(json, TRANSCRIPT_PREVIEW_MAX_BYTES - 64) };
}

function extractCreatedAtMs(content) {
  if (!content) return 0;
  const m = /^Created At:\s*([^\r\n]+)/m.exec(content);
  return m ? boardTimeMs(m[1].trim()) || 0 : 0;
}

function extractCompletedAtMs(content) {
  if (!content) return 0;
  const m = /^Completed At:\s*([^\r\n]+)/m.exec(content);
  return m ? boardTimeMs(m[1].trim()) || 0 : 0;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function checkConfinedSegment(segPath, expectedReal, brainRoot) {
  let lst;
  try {
    lst = lstatSync(segPath);
  } catch (err) {
    return err?.code === 'ENOENT' ? 'missing' : 'escape';
  }
  if (lst.isSymbolicLink()) return 'escape';
  try {
    const rp = realpathSync(segPath);
    if (!rp.startsWith(brainRoot) || rp !== expectedReal) return 'escape';
  } catch {
    return 'escape';
  }
  return 'ok';
}

function resolveConfinedTranscriptPath(appData, swarmId, memberConv) {
  let brainReal;
  try {
    brainReal = realpathSync(join(appData, 'brain'));
  } catch {
    return { ok: false, status: 404, error: 'Swarm not found' };
  }
  const brainRoot = brainReal.endsWith(sep) ? brainReal : brainReal + sep;
  try {
    const membersReal = realpathSync(join(swarmDir(appData, swarmId), 'members.json'));
    if (!membersReal.startsWith(brainRoot)) {
      return { ok: false, status: 400, error: 'Transcript path confinement violation' };
    }
  } catch {
    return { ok: false, status: 404, error: 'Swarm not found' };
  }

  const memberDir = join(appData, 'brain', memberConv);
  const sysDir = join(memberDir, '.system_generated');
  const logsDir = join(sysDir, 'logs');
  const trPath = join(logsDir, 'transcript.jsonl');

  const expectedMember = join(brainReal, memberConv);
  const expectedSys = join(expectedMember, '.system_generated');
  const expectedLogs = join(expectedSys, 'logs');
  const expectedTr = join(expectedLogs, 'transcript.jsonl');

  for (const [seg, exp] of [
    [memberDir, expectedMember],
    [sysDir, expectedSys],
    [logsDir, expectedLogs],
  ]) {
    const st = checkConfinedSegment(seg, exp, brainRoot);
    if (st === 'escape') return { ok: false, status: 400, error: 'Transcript path confinement violation' };
    if (st === 'missing') return { ok: true, missing: true, realTr: expectedTr };
  }

  const trState = checkConfinedSegment(trPath, expectedTr, brainRoot);
  if (trState === 'escape') return { ok: false, status: 400, error: 'Transcript path confinement violation' };
  if (trState === 'missing') return { ok: true, missing: true, realTr: expectedTr };

  try {
    const st = statSync(expectedTr);
    if (!st.isFile()) return { ok: false, status: 400, error: 'Invalid transcript file' };
    return { ok: true, missing: false, realTr: expectedTr, stat: st };
  } catch {
    return { ok: false, status: 400, error: 'Invalid transcript file' };
  }
}

function getCursorAnchor(realTr, st, before) {
  if (before === null || before === undefined) return st.size;
  const cached = transcriptCursorCache.get(realTr);
  if (!cached || cached.ino !== st.ino || st.size < cached.size) return st.size;
  const exact = cached.anchors.get(before);
  if (typeof exact === 'number' && exact <= st.size) return exact;
  let bestStep = Infinity;
  let bestOffset = st.size;
  for (const [si, off] of cached.anchors.entries()) {
    if (si >= before && si < bestStep && off <= st.size) {
      bestStep = si;
      bestOffset = off;
    }
  }
  return bestOffset;
}

function recordCursorAnchor(realTr, st, stepIndex, byteOffset) {
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || !Number.isFinite(byteOffset) || byteOffset < 0) return;
  let cached = transcriptCursorCache.get(realTr);
  if (!cached || cached.ino !== st.ino || st.size < cached.size) {
    cached = { ino: st.ino, size: st.size, anchors: new Map() };
  } else {
    cached.size = st.size;
  }
  if (cached.anchors.has(stepIndex)) cached.anchors.delete(stepIndex);
  else if (cached.anchors.size >= 64) cached.anchors.delete(cached.anchors.keys().next().value);
  cached.anchors.set(stepIndex, byteOffset);
  lruSet(transcriptCursorCache, realTr, cached, 16);
}

function readBackwardTranscriptLines(realTr, fileSize, readEndOffset, { before, limit, filter }) {
  const revLines = [];
  let pos = readEndOffset;
  let bytesScanned = 0;
  let trailingFrag = Buffer.alloc(0);
  let oversizedDrop = false;
  let stoppedEarly = false;
  let oldestScannedStepIndex = null;
  let oldestScannedByteOffset = pos;
  let nonGenericBeforeCursor = 0;
  let matchedEstimate = 0;
  let pendingGenericError = false;
  let pendingGenericTool = false;
  let lastParsedType = '';

  const chunkBuf = Buffer.allocUnsafe(TRANSCRIPT_BACK_CHUNK_BYTES);
  let fd;
  try {
    fd = openSync(realTr, 'r');
  } catch {
    return { error: true };
  }

  const processLineBuf = (buf, lineStartOffset) => {
    const line = buf.toString('utf8').trim();
    if (!line) return false;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return false;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

    const si = Number.isFinite(obj.step_index) ? obj.step_index : null;
    if (si !== null && (oldestScannedStepIndex === null || si < oldestScannedStepIndex)) {
      oldestScannedStepIndex = si;
      oldestScannedByteOffset = lineStartOffset;
    } else if (oldestScannedStepIndex === null) {
      oldestScannedByteOffset = lineStartOffset;
    }

    const type = safeStr(obj.type);
    lastParsedType = type;

    if (before !== null && si !== null && si >= before) {
      if (si < before + 32) {
        revLines.push({ byteOffset: lineStartOffset, raw: obj });
      }
      return false;
    }

    revLines.push({ byteOffset: lineStartOffset, raw: obj });

    if (type === 'GENERIC') {
      pendingGenericTool = true;
      if (safeStr(obj.status) === 'ERROR' || Boolean(obj.error)) pendingGenericError = true;
      return false;
    }

    nonGenericBeforeCursor++;
    if (filter === 'all') {
      matchedEstimate++;
    } else if (filter === 'tools') {
      const hasCalls = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
      if (hasCalls || pendingGenericTool) matchedEstimate++;
    } else if (filter === 'errors') {
      const isErr =
        type === 'ERROR_MESSAGE' ||
        safeStr(obj.status) === 'ERROR' ||
        Boolean(obj.error) ||
        pendingGenericError;
      if (isErr) matchedEstimate++;
    }
    pendingGenericError = false;
    pendingGenericTool = false;

    return matchedEstimate >= limit + 1;
  };

  try {
    while (pos > 0 && bytesScanned < TRANSCRIPT_PAGE_SCAN_BYTES && !stoppedEarly) {
      const remainingBudget = TRANSCRIPT_PAGE_SCAN_BYTES - bytesScanned;
      const toRead = Math.min(TRANSCRIPT_BACK_CHUNK_BYTES, pos, remainingBudget);
      if (toRead <= 0) break;
      const readStart = pos - toRead;
      let bytesRead = 0;
      try {
        bytesRead = readSync(fd, chunkBuf, 0, toRead, readStart);
      } catch {
        return { error: true };
      }
      if (bytesRead <= 0) break;
      bytesScanned += bytesRead;
      pos = readStart;

      const chunk = chunkBuf.subarray(0, bytesRead);
      const firstNl = chunk.indexOf(0x0a);

      if (firstNl < 0) {
        if (!oversizedDrop) {
          if (chunk.length + trailingFrag.length > MAX_LINE_BYTES) {
            oversizedDrop = true;
            trailingFrag = Buffer.alloc(0);
          } else {
            trailingFrag = trailingFrag.length ? Buffer.concat([chunk, trailingFrag]) : Buffer.from(chunk);
          }
        }
        continue;
      }

      const lastNl = chunk.lastIndexOf(0x0a);
      const tailSeg = chunk.subarray(lastNl + 1);
      if (!oversizedDrop) {
        const totalLen = tailSeg.length + trailingFrag.length;
        if (totalLen > 0 && totalLen <= MAX_LINE_BYTES) {
          const assembled = trailingFrag.length ? Buffer.concat([tailSeg, trailingFrag]) : tailSeg;
          if (processLineBuf(assembled, readStart + lastNl + 1)) {
            stoppedEarly = true;
            break;
          }
        }
      }
      oversizedDrop = false;
      trailingFrag = Buffer.alloc(0);

      let lineEnd = lastNl;
      while (lineEnd > firstNl) {
        const prevNl = chunk.lastIndexOf(0x0a, lineEnd - 1);
        const lineStart = prevNl + 1;
        const len = lineEnd - lineStart;
        if (len > 0 && len <= MAX_LINE_BYTES) {
          if (processLineBuf(chunk.subarray(lineStart, lineEnd), readStart + lineStart)) {
            stoppedEarly = true;
            break;
          }
        }
        lineEnd = prevNl;
      }
      if (stoppedEarly) break;

      if (firstNl > 0) {
        if (firstNl > MAX_LINE_BYTES) {
          oversizedDrop = true;
          trailingFrag = Buffer.alloc(0);
        } else {
          trailingFrag = Buffer.from(chunk.subarray(0, firstNl));
        }
      }
    }

    if (!stoppedEarly && pos === 0 && !oversizedDrop && trailingFrag.length > 0 && trailingFrag.length <= MAX_LINE_BYTES) {
      processLineBuf(trailingFrag, 0);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }

  return {
    error: false,
    revLines,
    reachedBeginning: !stoppedEarly && pos === 0,
    stoppedEarly,
    oldestScannedStepIndex,
    oldestScannedByteOffset,
    lastParsedType,
    nonGenericBeforeCursor,
  };
}

function correlateTranscriptSteps(revLines, reachedBeginning) {
  const chrono = [];
  for (let i = revLines.length - 1; i >= 0; i--) {
    chrono.push(revLines[i]);
  }

  // Fill any missing step_index monotonically
  let nextInfer = 0;
  for (let i = 0; i < chrono.length; i++) {
    const si = chrono[i].raw.step_index;
    if (Number.isFinite(si) && si >= 0) {
      chrono[i].stepIndex = si;
      nextInfer = si + 1;
    } else {
      chrono[i].stepIndex = reachedBeginning ? nextInfer++ : nextInfer++;
    }
  }

  const correlated = [];
  let currentPlanner = null;

  for (let i = 0; i < chrono.length; i++) {
    const { raw, byteOffset, stepIndex } = chrono[i];
    const type = safeStr(raw.type);

    if (type === 'GENERIC') {
      if (currentPlanner && currentPlanner.toolCalls.length > 0) {
        let targetTc = null;
        const callId = safeStr(raw.tool_call_id || raw.call_id);
        if (callId) {
          targetTc = currentPlanner.toolCalls.find((c) => c._id && c._id === callId && !c._paired);
        }
        if (!targetTc) {
          while (currentPlanner._nextCallIdx < currentPlanner.toolCalls.length) {
            const cand = currentPlanner.toolCalls[currentPlanner._nextCallIdx++];
            if (!cand._paired) {
              targetTc = cand;
              break;
            }
          }
        }
        if (targetTc) {
          targetTc._paired = true;
          const genStatus = safeStr(raw.status) || 'DONE';
          const genErr = safeStr(raw.error);
          const genContent = safeStr(raw.content);
          const combined = genErr && genContent ? `${genErr}\n${genContent}` : genErr || genContent;
          targetTc.status = genStatus;
          targetTc.outputPreview = truncateUtf8Bytes(scrubTranscriptText(combined), TRANSCRIPT_PREVIEW_MAX_BYTES);

          const genTs = boardTimeMs(raw.created_at) || 0;
          const createdIn = extractCreatedAtMs(genContent);
          const completedTs = extractCompletedAtMs(genContent) || genTs;
          if (!currentPlanner.ts) {
            currentPlanner.ts = createdIn || genTs;
          }
          if (currentPlanner.ts > 0 && completedTs >= currentPlanner.ts) {
            const span = completedTs - currentPlanner.ts;
            if (currentPlanner.durationMs === null || span > currentPlanner.durationMs) {
              currentPlanner.durationMs = span;
            }
          }
          continue;
        }
      }

      const genErr = safeStr(raw.error);
      const genContent = safeStr(raw.content);
      const genTs = boardTimeMs(raw.created_at) || 0;
      const createdIn = extractCreatedAtMs(genContent);
      const completedIn = extractCompletedAtMs(genContent);
      let durationMs = numOrNull(raw.duration_ms ?? raw.durationMs);
      if (durationMs === null && createdIn > 0 && completedIn >= createdIn) {
        durationMs = completedIn - createdIn;
      }
      correlated.push({
        stepIndex,
        type,
        status: safeStr(raw.status),
        ts: genTs,
        durationMs,
        model: safeStr(raw.model),
        thinking: '',
        content: truncateChars(scrubTranscriptText(genContent), TRANSCRIPT_TEXT_MAX_CHARS),
        error: truncateChars(scrubTranscriptText(genErr), TRANSCRIPT_TEXT_MAX_CHARS),
        toolCalls: [],
        usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
        _byteOffset: byteOffset,
      });
      continue;
    }

    if (currentPlanner) {
      if (currentPlanner.durationMs === null && type !== 'USER_INPUT' && currentPlanner.ts > 0) {
        const nextTs = boardTimeMs(raw.created_at) || 0;
        if (nextTs >= currentPlanner.ts) currentPlanner.durationMs = nextTs - currentPlanner.ts;
      }
      currentPlanner = null;
    }

    const ts = boardTimeMs(raw.created_at) || 0;
    const rawCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    const toolCalls = [];
    for (const tc of rawCalls) {
      if (!tc || typeof tc !== 'object') continue;
      toolCalls.push({
        name: safeStr(tc.name),
        summary: truncateChars(scrubTranscriptText(describeToolCall(tc)), TRANSCRIPT_TEXT_MAX_CHARS),
        args: scrubAndBoundArgs(tc.args),
        status: safeStr(tc.status),
        outputPreview: tc.output !== undefined ? truncateUtf8Bytes(scrubTranscriptText(safeStr(tc.output)), TRANSCRIPT_PREVIEW_MAX_BYTES) : '',
        _id: safeStr(tc.id),
        _paired: false,
      });
    }

    const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw;
    const inputTokens = cleanTok(u.input_tokens ?? u.inputTokens);
    const cacheReadTokens = cleanTok(u.cache_read_tokens ?? u.cacheReadTokens);
    const outputTokens = cleanTok(u.output_tokens ?? u.outputTokens);
    const errRaw = safeStr(raw.error) || (type === 'ERROR_MESSAGE' ? safeStr(raw.content) : '');

    const entry = {
      stepIndex,
      type,
      status: safeStr(raw.status) || (type === 'ERROR_MESSAGE' ? 'ERROR' : ''),
      ts,
      durationMs: numOrNull(raw.duration_ms ?? raw.durationMs),
      model: safeStr(raw.model),
      thinking: truncateChars(scrubTranscriptText(safeStr(raw.thinking)), TRANSCRIPT_TEXT_MAX_CHARS),
      content: truncateChars(scrubTranscriptText(safeStr(raw.content)), TRANSCRIPT_TEXT_MAX_CHARS),
      error: truncateChars(scrubTranscriptText(errRaw), TRANSCRIPT_TEXT_MAX_CHARS),
      toolCalls,
      usage: { inputTokens, cacheReadTokens, outputTokens },
      _byteOffset: byteOffset,
      _nextCallIdx: 0,
    };
    correlated.push(entry);
    if (type === 'PLANNER_RESPONSE' && toolCalls.length > 0) {
      currentPlanner = entry;
    }
  }

  return correlated;
}

function matchesTranscriptFilter(step, filter) {
  if (filter === 'all') return true;
  if (filter === 'tools') {
    return step.toolCalls.length > 0 || step.type === 'GENERIC';
  }
  if (filter === 'errors') {
    return (
      step.type === 'ERROR_MESSAGE' ||
      step.status === 'ERROR' ||
      Boolean(step.error) ||
      step.toolCalls.some((tc) => tc.status === 'ERROR')
    );
  }
  return false;
}

function stripInternalStepFields(step) {
  return {
    stepIndex: step.stepIndex,
    type: step.type,
    status: step.status,
    ts: step.ts,
    durationMs: step.durationMs,
    model: step.model,
    thinking: step.thinking,
    content: step.content,
    error: step.error,
    toolCalls: step.toolCalls.map((tc) => ({
      name: tc.name,
      summary: tc.summary,
      args: tc.args,
      status: tc.status,
      outputPreview: tc.outputPreview,
    })),
    usage: step.usage,
  };
}

/**
 * Bounded backwards deep transcript inspector for a swarm member.
 * Confines file access strictly via `members.json` -> `realpathSync` under `<appData>/brain/<memberConv>/.system_generated/logs/transcript.jsonl`.
 */
export function readTranscriptSteps(appDataDirs, opts = {}) {
  const dirs = Array.isArray(appDataDirs) ? appDataDirs : typeof appDataDirs === 'string' && appDataDirs ? [appDataDirs] : [];
  const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};

  const conversationId = typeof o.conversationId === 'string' ? o.conversationId.trim() : '';
  if (!conversationId || conversationId === '.' || conversationId === '..' || !ID_RE.test(conversationId)) {
    return { ok: false, status: 400, error: 'Invalid conversationId' };
  }

  const member = typeof o.member === 'string' ? o.member.trim() : '';
  if (
    !member ||
    member.length > 128 ||
    /[\x00-\x1f\x7f/\\]/.test(member) ||
    member === '__proto__' ||
    member === 'constructor' ||
    member === 'prototype'
  ) {
    return { ok: false, status: 400, error: 'Invalid member' };
  }

  let before = null;
  if (o.before !== undefined && o.before !== null && o.before !== '') {
    if (typeof o.before === 'boolean' || !/^\d+$/.test(String(o.before).trim())) {
      return { ok: false, status: 400, error: 'Invalid before cursor' };
    }
    before = Number(String(o.before).trim());
    if (!Number.isSafeInteger(before) || before < 0) {
      return { ok: false, status: 400, error: 'Invalid before cursor' };
    }
  }

  let limit = 25;
  if (o.limit !== undefined && o.limit !== null && o.limit !== '') {
    if (typeof o.limit === 'boolean' || (typeof o.limit === 'string' && !/^-?\d+$/.test(o.limit.trim()))) {
      return { ok: false, status: 400, error: 'Invalid limit' };
    }
    const rawLimit = Number(o.limit);
    if (!Number.isFinite(rawLimit) || !Number.isInteger(rawLimit)) {
      return { ok: false, status: 400, error: 'Invalid limit' };
    }
    limit = Math.max(1, Math.min(50, rawLimit));
  }

  const filter = o.filter === undefined || o.filter === null || o.filter === '' ? 'all' : String(o.filter).trim();
  if (filter !== 'all' && filter !== 'errors' && filter !== 'tools') {
    return { ok: false, status: 400, error: 'filter must be all, errors, or tools' };
  }

  const resolved = resolveConversationSwarm(dirs, conversationId);
  if (!resolved.swarm || !resolved.appData) {
    return { ok: false, status: 404, error: 'Swarm not found' };
  }

  const roster = getSwarmRoster(resolved.appData, resolved.swarm);
  if (!roster || !roster.members || !Object.hasOwn(roster.members, member)) {
    return { ok: false, status: 404, error: 'Member not found' };
  }

  const mObj = roster.members[member];
  const memberConv = typeof mObj?.conversation_id === 'string' ? mObj.conversation_id.trim() : '';
  if (!memberConv || memberConv === '.' || memberConv === '..' || !ID_RE.test(memberConv) || /[\\/%]/.test(memberConv)) {
    return { ok: false, status: 400, error: 'Invalid member conversationId' };
  }

  const confined = resolveConfinedTranscriptPath(resolved.appData, resolved.swarm, memberConv);
  if (!confined.ok) return confined;

  if (confined.missing || confined.stat.size === 0) {
    return {
      ok: true,
      member,
      conversationId: memberConv,
      swarm: resolved.swarm,
      totalSteps: 0,
      nextBefore: null,
      hasMore: false,
      steps: [],
    };
  }

  const trSummary = summarizeTranscript(resolved.appData, memberConv);
  const totalSteps = trSummary?.summary?.steps || 0;

  if (before === 0) {
    return {
      ok: true,
      member,
      conversationId: memberConv,
      swarm: resolved.swarm,
      totalSteps,
      nextBefore: null,
      hasMore: false,
      steps: [],
    };
  }

  const readEndOffset = getCursorAnchor(confined.realTr, confined.stat, before);
  const scan = readBackwardTranscriptLines(confined.realTr, confined.stat.size, readEndOffset, {
    before,
    limit,
    filter,
  });
  if (scan.error) {
    return { ok: false, status: 404, error: 'Transcript unreadable' };
  }

  const correlated = correlateTranscriptSteps(scan.revLines, scan.reachedBeginning);
  const eligible = correlated.filter((s) => (before === null || s.stepIndex < before) && matchesTranscriptFilter(s, filter));
  const eligibleDesc = eligible.slice().reverse();
  const pageRaw = eligibleDesc.slice(0, limit);
  const steps = pageRaw.map(stripInternalStepFields);

  let hasMore = false;
  let nextBefore = null;
  if (eligibleDesc.length > limit) {
    const oldestReturned = pageRaw[pageRaw.length - 1];
    if (oldestReturned.stepIndex > 0 && (before === null || oldestReturned.stepIndex < before)) {
      hasMore = true;
      nextBefore = oldestReturned.stepIndex;
      recordCursorAnchor(confined.realTr, confined.stat, nextBefore, oldestReturned._byteOffset);
    }
  } else if (!scan.reachedBeginning) {
    const cursorStep =
      pageRaw.length > 0 && filter === 'all'
        ? pageRaw[pageRaw.length - 1].stepIndex
        : scan.oldestScannedStepIndex;
    const cursorOffset =
      pageRaw.length > 0 && filter === 'all'
        ? pageRaw[pageRaw.length - 1]._byteOffset
        : scan.oldestScannedByteOffset;
    if (cursorStep !== null && cursorStep > 0 && (before === null || cursorStep < before)) {
      hasMore = true;
      nextBefore = cursorStep;
      recordCursorAnchor(confined.realTr, confined.stat, nextBefore, cursorOffset);
    }
  }

  return {
    ok: true,
    member,
    conversationId: memberConv,
    swarm: resolved.swarm,
    totalSteps: Math.max(totalSteps, correlated.length ? correlated[correlated.length - 1].stepIndex + 1 : 0),
    nextBefore,
    hasMore,
    steps,
  };
}
