/**
 * Antigravity native swarm & transcript store for Fleet sidecar.
 * Reads <appData>/brain/<conv>/.system_generated/{swarm,logs}/ read-only.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
  currentChannels,
  effectiveChannels,
  mentionsOf,
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

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function statOf(path) {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

const fileCache = new Map();
function readCached(path, maxBytes = Infinity) {
  const s = statOf(path);
  if (s.size < 0) return { text: null, ...s };
  if (s.size > maxBytes) return { text: null, tooLarge: true, ...s };
  const key = `${s.mtime}:${s.size}`;
  const hit = fileCache.get(path);
  if (hit && hit.key === key) return { text: hit.text, ...s };
  let text = null;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { text: null, ...s };
  }
  if (fileCache.size > 800) fileCache.clear();
  fileCache.set(path, { key, text });
  return { text, ...s };
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

export function parseBoard(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object' && !Array.isArray(m)) out.push(m);
    } catch {
      // Torn trailing line is ignored until next poll.
    }
  }
  return out;
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

function turnEnded(parsedSteps) {
  const results = [];
  for (let i = parsedSteps.length - 1; i >= 0; i--) {
    const step = parsedSteps[i];
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

function finalReply(parsedSteps) {
  if (!parsedSteps.length) return null;
  const step = parsedSteps[parsedSteps.length - 1];
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

/** Parse a member's `transcript.jsonl` into steps, activity, state, and real token usage. */
export function summarizeTranscript(appData, conv) {
  if (!appData || !conv || !ID_RE.test(conv)) return NO_TRANSCRIPT;
  const path = transcriptPath(appData, conv);
  const s = statOf(path);
  if (s.size < 0) return NO_TRANSCRIPT;
  const key = `${s.mtime}:${s.size}`;
  const hit = transcriptCache.get(path);
  if (hit && hit.key === key) return hit;

  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return NO_TRANSCRIPT;
  }

  const lines = text.split('\n').filter((l) => l.trim());
  const parsedSteps = [];
  let maxStepIndex = lines.length;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let model = '';
  let startedAt = '';
  let lastStepAt = '';

  for (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      parsedSteps.push(null);
      continue;
    }
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      parsedSteps.push(null);
      continue;
    }
    parsedSteps.push(step);
    if (Number.isFinite(step.step_index)) {
      maxStepIndex = Math.max(maxStepIndex, step.step_index + 1);
    }
    if (typeof step.created_at === 'string' && step.created_at) {
      if (!startedAt) startedAt = step.created_at;
      lastStepAt = step.created_at;
    }
    if (typeof step.model === 'string' && step.model) {
      model = step.model;
    }
    if (step.type === 'PLANNER_RESPONSE') {
      const u = step.usage && typeof step.usage === 'object' ? step.usage : step;
      inputTokens += num(Number(u.input_tokens));
      cacheReadTokens += num(Number(u.cache_read_tokens ?? u.cacheReadTokens));
      outputTokens += num(Number(u.output_tokens));
    }
  }

  let activity = '';
  let activityKind = '';
  let last = null;
  for (let i = parsedSteps.length - 1; i >= 0; i--) {
    const step = parsedSteps[i];
    if (!step) continue;
    if (!last) {
      last = {
        type: String(step.type || ''),
        status: String(step.status || ''),
        error: typeof step.error === 'string' ? oneLine(step.error, 240) : '',
      };
    }
    if (step.type === 'USER_INPUT') break;
    if (step.type !== 'PLANNER_RESPONSE') continue;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.some((tc) => tc?.name === 'swarm_wait')) break;
    const labeled = calls.filter((tc) => describeToolCall(tc)).pop();
    const label = labeled ? describeToolCall(labeled) : '';
    const heading = thinkingHeading(step.thinking);
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

  const idle = turnEnded(parsedSteps);
  const reply = finalReply(parsedSteps);
  const replied = reply !== null;
  const replyAsk = replied ? replyQuestion(reply) : '';
  const totalTokens = inputTokens + cacheReadTokens + outputTokens;

  const entry = {
    key,
    summary: {
      steps: maxStepIndex,
      activity,
      activityKind,
      last,
      idle,
      replied,
      replyAsk,
      mtime: s.mtime,
      model,
      startedAt,
      lastStepAt,
      usage: {
        inputTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens,
      },
    },
  };
  if (transcriptCache.size > 500) transcriptCache.clear();
  transcriptCache.set(path, entry);
  return entry;
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
    for (const g of String(m.text ?? '').matchAll(SHOT_RE)) {
      out.delete(g[1]);
      out.set(g[1], { path: g[1], seq: Number(m.seq) || 0, caption: String(g[2] || '').slice(0, 80) });
    }
  }
  return [...out.values()].slice(-MAX_POSTED_FRAMES);
}

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
    viewJsonCache.set(id, c);
  }
  return { json: c.good?.json || null, mtime: c.good?.mtime || 0, error: c.error };
}

function readView(appData, id, dir, narrator) {
  let vdir = dir;
  let source = 'swarm';
  let jf = readCached(join(dir, 'view.json'), VIEW_MAX_BYTES);
  const conv = narrator?.conversation_id;
  if (jf.size < 0 && typeof conv === 'string' && ID_RE.test(conv)) {
    const alt = join(appData, 'brain', conv, 'swarm_view');
    const altJson = readCached(join(alt, 'view.json'), VIEW_MAX_BYTES);
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
  const pf = readCached(join(dir, 'plan.json'), VIEW_MAX_BYTES);
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
          ? `@${sys.member} Hit quota/rate-limit on last step. Resume or report status.`
          : `@${sys.member} Last step blocked (${sys.kind}). Check diagnostics and continue.`,
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
      suggestedPrompt: `Answering your question: `,
      timestamp: m.transcriptMtime || m.lastPostTs || 0,
    });
  }

  // Unresolved [blocked] posts and unverified [done] worker posts.
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
        detail: oneLine(msg.text, 160),
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
        detail: oneLine(msg.text, 160),
        suggestedPrompt: `@verifier Cold-verify ${msg.agent}'s #${msg.seq} deliverable and post [verified] or [blocked].`,
        timestamp: msg.ts || 0,
      });
    }
  }

  const order = { urgent: 0, attention: 1, verify: 2 };
  items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || b.timestamp - a.timestamp);
  return items;
}

/** Build a complete snapshot for a local file-backed swarm. */
export function buildSwarmSnapshot(appData, id) {
  const dir = swarmDir(appData, id);
  const membersFile = readCached(join(dir, 'members.json'));
  if (membersFile.text == null) return null;
  const boardFile = readCached(join(dir, 'board.jsonl'));
  const roster = parseRoster(membersFile.text) || { title: '', members: {} };
  const msgs = parseBoard(boardFile.text);
  const title = roster.title || id;
  const head = msgs.length ? Number(msgs[msgs.length - 1].seq) || msgs.length : 0;
  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
  const transcripts = new Map(names.map((n) => [n, summarizeTranscript(appData, roster.members[n].conversation_id)]));
  const trKeys = names.map((n) => `${n}:${transcripts.get(n).key}`).join(',');
  const narratorName = pickNarrator(roster);
  const vf = readView(appData, id, dir, narratorName ? roster.members[narratorName] : null);
  const { plan, key: planKey } = readPlan(dir);
  const frames = postedFrames(roster, msgs);
  const allowedFiles = allowedFilesOf(appData, vf.view.json);
  const now = Date.now();
  const failures = new Map(names.map((n) => [n, stepFailure(transcripts.get(n).summary, now)]));
  const stuckKeys = names
    .map((n) => {
      const f = failures.get(n);
      const mt = transcripts.get(n).summary?.mtime || 0;
      return `${f ? f.kind : ''}${mt && now - mt > STUCK_MS ? 's' : ''}`;
    })
    .join(',');

  const etag = `${membersFile.mtime}:${membersFile.size}|${boardFile.mtime}:${boardFile.size}|${title}|${trKeys}|${vf.etag}|${planKey}|${stuckKeys}`;

  const posts = new Map();
  const edges = new Map();
  const channels = channelRegistry(msgs);
  const byChannel = channelAddressees(roster, names, msgs, channels);

  const messages = msgs.map((m, i) => {
    const seq = Number(m.seq) || 0;
    const agent = String(m.agent ?? '');
    const text = String(m.text ?? '');
    const time = m.time || '';
    const ts = boardTimeMs(time);
    const channel = channelOf(m);
    const control = controlOf(m);
    const chanFields = { ...(channel !== MAIN ? { channel } : {}), ...(control ? { control } : {}) };
    if (control) return { seq, agent, text, time, ts, mentions: [], all: false, ...chanFields };
    const { mentions, all } = mentionsOf(text, names);
    const ch = byChannel ? byChannel(i, text) : null;
    const viaChannel = ch ? ch.members.filter((n) => n !== agent && !mentions.includes(n)) : [];
    const chanMentionFields = ch?.channels.length ? { channel_mentions: ch.channels, via_channel: viaChannel } : {};
    const p = posts.get(agent) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
    posts.set(agent, { posts: p.posts + 1, lastPostSeq: seq, lastPostTime: time, lastPostTs: ts });
    if (!isRoleWorker(agent, roster.members[agent])) {
      const direct = new Set([...mentions, ...viaChannel]);
      const targets = new Set(all ? names : mentions);
      for (const n of direct) targets.add(n);
      targets.delete(agent);
      for (const to of targets) {
        if (isRoleWorker(to, roster.members[to])) continue;
        const key = `${agent}\0${to}`;
        const e = edges.get(key) || { from: agent, to, count: 0, direct: 0, viaAll: 0 };
        e.count++;
        if (direct.has(to)) e.direct++;
        else e.viaAll++;
        edges.set(key, e);
      }
    }
    return { seq, agent, text, time, ts, mentions, all, ...chanFields, ...chanMentionFields };
  });

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

  return {
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
    usage: {
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
    },
    raw: { members: membersFile.text || '', board: boardFile.text || '', view: vf.rawJson },
  };
}

/** Resolve which swarm a conversation belongs to (coordinator dir or member roster). */
export function resolveConversationSwarm(appDataDirs, conv) {
  if (!conv || !ID_RE.test(conv)) return { appData: null, swarm: null, member: null };
  for (const appData of appDataDirs) {
    if (existsSync(join(swarmDir(appData, conv), 'members.json'))) {
      const text = readCached(join(swarmDir(appData, conv), 'members.json')).text;
      const roster = parseRoster(text || '');
      const member = Object.entries(roster?.members || {}).find(([, m]) => m?.conversation_id === conv)?.[0] || null;
      return { appData, swarm: conv, member };
    }
  }
  for (const appData of appDataDirs) {
    for (const id of safeReaddir(join(appData, 'brain'))) {
      if (!ID_RE.test(id)) continue;
      const text = readCached(join(swarmDir(appData, id), 'members.json')).text;
      if (!text) continue;
      const roster = parseRoster(text);
      const member = Object.entries(roster?.members || {}).find(([, m]) => m?.conversation_id === conv)?.[0] || null;
      if (member) return { appData, swarm: id, member };
    }
  }
  return { appData: null, swarm: null, member: null };
}

/** Scan all available local swarms across `appDataDirs` for the Multi-Swarm Switcher. */
export function listSwarms(appDataDirs) {
  const seen = new Set();
  const list = [];
  for (const appData of appDataDirs) {
    for (const id of safeReaddir(join(appData, 'brain'))) {
      if (seen.has(id) || !ID_RE.test(id)) continue;
      const mPath = join(swarmDir(appData, id), 'members.json');
      if (!existsSync(mPath)) continue;
      seen.add(id);
      const snap = buildSwarmSnapshot(appData, id);
      if (!snap) continue;
      const activeCount = snap.members.filter((m) => !m.killed && m.status === 'working').length;
      const waitingCount = snap.members.filter((m) => !m.killed && m.status === 'waiting').length;
      const killedCount = snap.members.filter((m) => m.killed).length;
      const lastActivityTs = Math.max(
        statOf(join(swarmDir(appData, id), 'board.jsonl')).mtime || 0,
        statOf(mPath).mtime || 0,
        ...snap.members.map((m) => m.transcriptMtime || 0),
      );
      list.push({
        id: snap.id,
        title: snap.title,
        appData,
        head: snap.head,
        memberCount: snap.members.length,
        activeCount,
        waitingCount,
        killedCount,
        triageCount: snap.triage.length,
        totalTokens: snap.usage.totalTokens,
        hasPlan: Boolean(snap.plan),
        lastActivityTs,
      });
    }
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

  const snap = buildSwarmSnapshot(appData, swarmId);
  if (!snap) return null;

  const viewFrames = Array.isArray(snap.view?.json?.reel?.frames) ? snap.view.json.reel.frames : [];
  const listed =
    viewFrames.some((f) => f && f.path === targetPath) ||
    snap.frames.some((f) => f && f.path === targetPath);
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
