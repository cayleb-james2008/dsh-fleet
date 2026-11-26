import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executeWorktreeAction,
  parsePorcelainWorktrees,
  probeMemberWorktree,
  probeWorktreeDiff,
  probeWorktrees,
} from '../git_probe.mjs';
import {
  OPS_TIMEOUT_MS,
  buildSwarmDelta,
  buildSwarmSnapshot,
  computeBurnSummary,
  computeGateReadiness,
  findCoordinatorConvId,
  getBoardTailStats,
  getModelSpec,
  getSwarmOpContext,
  listSwarms,
  normalizePlan,
  readOperatorOps,
  readTranscriptActivityTail,
  readTranscriptSteps,
  reconcileOperatorOps,
  recordOperatorOp,
  summarizeTranscript,
  writeSwarmPlan,
} from '../swarm_store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeScratchDir(prefix) {
  const base = join(__dirname, '.scratch');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

test('summarizeTranscript extracts activity, tokens, replyAsk, and ignores torn JSONL', () => {
  const dir = makeScratchDir('transcript-');
  try {
    const conv = '11111111-1111-1111-1111-111111111111';
    const logsDir = join(dir, 'brain', conv, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          content: 'Start task',
          created_at: '2026-11-25T10:00:00Z',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-3-pro',
          input_tokens: 1200,
          cache_read_tokens: 400,
          output_tokens: 150,
          thinking: '**Inspecting router tests**\nChecking routes.',
          tool_calls: [{ name: 'run_command', args: { toolSummary: '"Run unit tests"' } }],
          created_at: '2026-11-25T10:00:05Z',
        }),
        JSON.stringify({ type: 'GENERIC', status: 'DONE', step_index: 2 }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-3-pro',
          input_tokens: 800,
          cache_read_tokens: 600,
          output_tokens: 90,
          content: 'Tests pass. Should I merge to main now?',
          tool_calls: [],
          created_at: '2026-11-25T10:00:12Z',
        }),
      ].join('\n'),
    );

    const { summary } = summarizeTranscript(dir, conv);
    assert.ok(summary);
    assert.equal(summary.usage.inputTokens, 2000);
    assert.equal(summary.usage.cacheReadTokens, 1000);
    assert.equal(summary.usage.outputTokens, 240);
    assert.equal(summary.usage.totalTokens, 3240);
    assert.equal(summary.model, 'gemini-3-pro');
    assert.equal(summary.replied, true);
    assert.equal(summary.replyAsk, 'Should I merge to main now?');
    assert.equal(summary.activity, 'Run unit tests');
    assert.equal(summary.activityKind, 'tool');

    // A trailing torn line does not crash or corrupt cumulative token telemetry
    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 20, tool_calls: [{ name: 'read_file', args: { Path: '/a.ts' } }] }) +
        '\n{"broken_torn_line": true',
    );
    const torn = summarizeTranscript(dir, conv);
    assert.ok(torn.summary);
    assert.equal(torn.summary.usage.totalTokens, 120);
    assert.equal(torn.summary.replied, false);

    // Completing the torn line incrementally updates tokens and recentTools without full rescan
    const appendLine = ', "step_index": 1, "type": "PLANNER_RESPONSE", "input_tokens": 50, "output_tokens": 10, "tool_calls": [{"name": "edit_file", "args": {"Path": "/b.ts"}}]}\n';
    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 20, tool_calls: [{ name: 'read_file', args: { Path: '/a.ts' } }] }) +
        '\n{"broken_torn_line": true' + appendLine,
    );
    const resumed = summarizeTranscript(dir, conv);
    assert.ok(resumed.summary);
    assert.equal(resumed.summary.usage.totalTokens, 180);
    assert.equal(resumed.summary.recentTools.length, 2);
    assert.equal(resumed.summary.recentTools[0].summary, 'Edit b.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSwarmSnapshot and listSwarms aggregate plan, triage, frames, and token totals', () => {
  const dir = makeScratchDir('swarm-');
  try {
    const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const verifierId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const swarmPath = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swarmPath, { recursive: true });
    mkdirSync(join(dir, 'brain', workerId, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(dir, 'brain', verifierId, '.system_generated', 'logs'), { recursive: true });

    writeFileSync(
      join(swarmPath, 'members.json'),
      JSON.stringify({
        title: 'Release 1.0',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', wake_mode: 'mentions', last_read_seq: 2 },
          builder: { conversation_id: workerId, role: 'worker', model: 'gemini-3-pro', wake_mode: 'mentions', last_read_seq: 2, workspace_mode: 'share' },
          verifier: { conversation_id: verifierId, role: 'worker', wake_mode: 'mentions', last_read_seq: 0 },
        },
      }),
    );

    writeFileSync(
      join(swarmPath, 'plan.json'),
      JSON.stringify({
        title: 'Ship Fleet Sidecar',
        goal: 'Move Fleet into Antigravity aux pane',
        gate: 'npm test',
        workstreams: [{ id: 'ws-1', title: 'Sidecar backend', owner: 'builder', status: 'done' }],
      }),
    );

    const shotPath = join(dir, 'brain', workerId, 'screen.png');
    writeFileSync(shotPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    writeFileSync(
      join(swarmPath, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder Start work', time: '2026-11-25 10:00:00' }),
        JSON.stringify({
          seq: 2,
          agent: 'builder',
          text: `@verifier [done] Backend ready.\nScreenshot: ${shotPath} | Sidebar frame`,
          time: '2026-11-25 10:05:00',
        }),
      ].join('\n'),
    );

    writeFileSync(
      join(dir, 'brain', workerId, '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        input_tokens: 500,
        output_tokens: 100,
        cache_read_tokens: 0,
        tool_calls: [{ name: 'swarm_wait', args: {} }],
      }) +
        '\n' +
        JSON.stringify({ type: 'GENERIC', status: 'DONE' }),
    );

    writeFileSync(
      join(dir, 'brain', verifierId, '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'ERROR_MESSAGE',
        error: 'RESOURCE_EXHAUSTED quota hit',
      }),
    );

    const snap = buildSwarmSnapshot(dir, coordId);
    assert.ok(snap);
    assert.equal(snap.title, 'Release 1.0');
    assert.equal(snap.plan.goal, 'Move Fleet into Antigravity aux pane');
    assert.equal(snap.usage.totalTokens, 600);
    assert.equal(snap.frames.length, 1);
    assert.equal(snap.frames[0].caption, 'Sidebar frame');

    const kinds = snap.triage.map((t) => t.kind);
    assert.ok(kinds.includes('quota'));
    assert.ok(kinds.includes('verify'));

    const swarms = listSwarms([dir]);
    assert.equal(swarms.length, 1);
    assert.equal(swarms[0].id, coordId);
    assert.equal(swarms[0].hasPlan, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git_probe parses porcelain output, inspects real git worktrees, and rejects traversal roots', async () => {
  const sample = [
    'worktree /repo/main',
    'HEAD 1234567890abcdef',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-feature',
    'HEAD fedcba9876543210',
    'detached',
    '',
  ].join('\n');
  const parsed = parsePorcelainWorktrees(sample);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].branch, 'main');
  assert.equal(parsed[1].detached, true);

  const repoDir = makeScratchDir('gitrepo-');
  try {
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    writeFileSync(join(repoDir, 'README.md'), '# hello\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' });

    const wtDir = join(dirname(repoDir), `wt-${Date.now()}`);
    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/test', wtDir], { stdio: 'ignore' });
      writeFileSync(join(wtDir, 'README.md'), '# hello\n' + 'line '.repeat(2600));
      writeFileSync(join(wtDir, 'dirty.txt'), 'change');
      symlinkSync('/etc/hosts', join(wtDir, 'escape-link'));

      const res = await probeWorktrees([repoDir, 'file:///etc/../etc/passwd', '../relative'], { ttlMs: 0 });
      assert.equal(res.rejected.length, 2);
      assert.equal(res.worktrees.length, 2);
      const feat = res.worktrees.find((w) => w.branch === 'feat/test');
      assert.ok(feat);
      assert.equal(feat.clean, false);
      assert.equal(feat.landStatus, 'dirty');
      assert.equal(feat.untrackedFiles, 2);
      assert.equal(feat.lastCommitSubject, 'Initial commit');
      const dirtyEntry = feat.files.find((f) => f.path === 'dirty.txt');
      const escapeEntry = feat.files.find((f) => f.path === 'escape-link');
      assert.ok(dirtyEntry && dirtyEntry.state === '??' && dirtyEntry.uri.endsWith('/dirty.txt'));
      assert.ok(escapeEntry && escapeEntry.uri === '');

      // Worktree diff peek + truncation + CWE-22 / CWE-59 confinement
      const dMod = await probeWorktreeDiff({ root: repoDir, worktree: wtDir, file: 'README.md' });
      assert.equal(dMod.ok, true);
      assert.equal(dMod.truncated, true);
      assert.ok(Buffer.byteLength(dMod.diff, 'utf8') <= 8192);
      assert.ok(dMod.added >= 1);

      const dUntracked = await probeWorktreeDiff({ root: repoDir, worktree: wtDir, file: 'dirty.txt' });
      assert.equal(dUntracked.ok, true);
      assert.equal(dUntracked.untracked, true);
      assert.ok(dUntracked.diff.includes('+change'));

      const dTrav = await probeWorktreeDiff({ root: repoDir, worktree: wtDir, file: '../README.md' });
      assert.equal(dTrav.ok, false);
      assert.equal(dTrav.status, 400);

      const dSymlink = await probeWorktreeDiff({ root: repoDir, worktree: wtDir, file: 'escape-link' });
      assert.equal(dSymlink.ok, false);
      assert.equal(dSymlink.status, 404);

      const dOutsideWt = await probeWorktreeDiff({ root: repoDir, worktree: '/etc', file: 'passwd' });
      assert.equal(dOutsideWt.ok, false);
      assert.equal(dOutsideWt.status, 404);

      // Commit dirty changes and remove untracked symlink -> becomes clean ahead of main ('ready')
      rmSync(join(wtDir, 'escape-link'));
      execFileSync('git', ['-C', wtDir, 'add', 'README.md', 'dirty.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', wtDir, 'commit', '-m', 'Ready branch'], { stdio: 'ignore' });
      const resReady = await probeWorktrees([repoDir], { ttlMs: 0 });
      const featReady = resReady.worktrees.find((w) => w.branch === 'feat/test');
      assert.equal(featReady?.landStatus, 'ready');
      assert.equal(featReady?.ahead, 1);
      assert.equal(featReady?.behind, 0);

      // Advance main by 1 commit -> feat/test becomes behind ('rebase')
      writeFileSync(join(repoDir, 'main-only.txt'), 'advance');
      execFileSync('git', ['-C', repoDir, 'add', 'main-only.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Advance main'], { stdio: 'ignore' });
      const resBehind = await probeWorktrees([repoDir], { ttlMs: 0 });
      const featBehind = resBehind.worktrees.find((w) => w.branch === 'feat/test');
      assert.equal(featBehind?.landStatus, 'rebase');
      assert.equal(featBehind?.ahead, 1);
      assert.equal(featBehind?.behind, 1);
    } finally {
      execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', wtDir], { stdio: 'ignore' });
      rmSync(wtDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('computeBurnSummary flags top consumer share and high-burn levels cleanly', () => {
  const burn = computeBurnSummary(
    [
      { name: 'coordinator', usage: { totalTokens: 6000 }, roleWorker: false },
      { name: 'builder', usage: { totalTokens: 28000 }, roleWorker: false },
      { name: 'narrator-1', usage: { totalTokens: 999999 }, roleWorker: true },
    ],
    34000,
  );
  assert.equal(burn.topWorker?.name, 'builder');
  assert.equal(burn.topWorker?.sharePct, 82);
  assert.equal(burn.topWorker?.level, 'critical');
  assert.equal(burn.highBurnCount, 1);
  assert.equal(burn.workers.length, 2);

  const warnBurn = computeBurnSummary(
    [
      { name: 'coordinator', usage: { totalTokens: 7000 }, roleWorker: false },
      { name: 'builder', usage: { totalTokens: 8000 }, roleWorker: false },
    ],
    15000,
  );
  assert.equal(warnBurn.topWorker?.level, 'warn');
  assert.equal(warnBurn.topWorker?.sharePct, 53);
});

test('computeGateReadiness tracks release gate progression, pending #seq jumps, and nextAction context', () => {
  const members = [
    { name: 'ux-verifier', conversation_id: 'conv-ux', killed: false },
    { name: 'scale-auditor', conversation_id: 'conv-sc', killed: false },
    { name: 'release-ops', conversation_id: 'conv-rel', killed: false },
    { name: 'builder', conversation_id: 'conv-bld', killed: false },
  ];
  const verifying = computeGateReadiness(
    [
      { seq: 4, agent: 'builder', text: '@ux-verifier [done] Ready' },
      { seq: 5, agent: 'ux-verifier', text: '@scale-auditor [verified] OK' },
      { seq: 8, agent: 'builder', text: '@ux-verifier [done] Followup\nBranch: release/1.15.0 | Commit: abcdef123456' },
    ],
    [],
    { members, title: 'Fleet v1.15.0' },
  );
  assert.equal(verifying?.state, 'verifying');
  assert.equal(verifying?.pendingSeq, 8);
  assert.equal(verifying?.stages[0].count, 2);
  assert.equal(verifying?.stages[1].seq, 5);
  assert.equal(verifying?.velocity?.passRatePct, 100);
  assert.equal(verifying?.velocity?.shippedSeq, 5);
  assert.equal(verifying?.nextAction?.kind, 'verify');
  assert.equal(verifying?.nextAction?.target, 'ux-verifier');
  assert.equal(verifying?.nextAction?.conversationId, 'conv-ux');
  assert.ok(verifying?.nextAction?.prompt.includes('Re #8:'));
  assert.ok(verifying?.nextAction?.prompt.includes('release/1.15.0 @ abcdef12'));

  const blocked = computeGateReadiness(
    [
      { seq: 4, agent: 'builder', text: '@ux-verifier [done] Ready' },
      { seq: 6, agent: 'ux-verifier', text: '@builder [blocked] Fix header icon' },
    ],
    [{ kind: 'blocked', severity: 'urgent', seq: 6, member: 'builder', conversationId: 'conv-bld' }],
    { members, title: 'Fleet v1.15.0' },
  );
  assert.equal(blocked?.state, 'blocked');
  assert.equal(blocked?.pendingSeq, 6);
  assert.equal(blocked?.velocity?.passRatePct, 50);
  assert.equal(blocked?.velocity?.blocked, 1);
  assert.equal(blocked?.nextAction?.kind, 'unblock');
  assert.equal(blocked?.nextAction?.target, 'builder');
  assert.equal(blocked?.nextAction?.conversationId, 'conv-bld');

  const ready = computeGateReadiness(
    [
      { seq: 1, agent: 'a', text: '[done]', ts: 1_000_000 },
      { seq: 2, agent: 'b', text: '[verified]', ts: 1_900_000 },
      { seq: 3, agent: 'c', text: '[scale-verified]', ts: 2_800_000 },
      { seq: 4, agent: 'release-ops', text: 'v1.15.0 shipped', ts: 4_600_000 },
    ],
    [],
    { members, title: 'Fleet v1.15.0' },
  );
  assert.equal(ready?.state, 'ready');
  assert.equal(ready?.pendingSeq, 3);
  assert.equal(ready?.velocity?.passRatePct, 100);
  assert.equal(ready?.velocity?.waves, 1);
  assert.equal(ready?.velocity?.wavesPerHr, 1);
  assert.equal(ready?.velocity?.shippedSeq, 4);
  assert.equal(ready?.velocity?.exactShipped, true);
  assert.equal(ready?.nextAction?.kind, 'ship');
  assert.equal(ready?.nextAction?.target, 'release-ops');
});

test('readTranscriptActivityTail reads trailing 8 KB, masks /home/ paths, caches by mtime, and updates cleanly', () => {
  const dir = makeScratchDir('tail-peek-');
  try {
    const conv = 'aaaa1111-1111-4111-8111-111111111111';
    const logDir = join(dir, 'brain', conv, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const tp = join(logDir, 'transcript.jsonl');

    // Seed > 10 KB of older history so bounded 8 KB reader skips earlier steps
    const pad = 'x'.repeat(300);
    const oldLines = Array.from({ length: 36 }, (_, i) =>
      JSON.stringify({
        step_index: i,
        type: 'PLANNER_RESPONSE',
        content: pad,
        created_at: '2026-11-25T12:00:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: '/home/alice/repo/old.ts' } }],
      }),
    ).join('\n');
    const latestStep = JSON.stringify({
      step_index: 36,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-25T12:05:00Z',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'cargo test --manifest-path /home/alice/work/app/Cargo.toml' } }],
    });
    writeFileSync(tp, `${oldLines}\n${latestStep}\n`);

    const p1 = readTranscriptActivityTail(dir, conv);
    assert.ok(p1);
    assert.equal(p1.status, 'working');
    assert.equal(p1.tool, 'run_command');
    assert.ok(p1.label.includes('~/work/app/Cargo.toml'), `Expected ~/ masking, got ${p1.label}`);
    assert.ok(!p1.label.includes('/home/'), `Leaked /home/: ${p1.label}`);

    // Unchanged stat returns identical cached object
    const p1Cached = readTranscriptActivityTail(dir, conv);
    assert.equal(p1Cached, p1);

    // Appending a swarm_wait step shifts tail peek to waiting
    appendFileSync(
      tp,
      `${JSON.stringify({
        step_index: 37,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T12:06:00Z',
        tool_calls: [{ name: 'swarm_wait', args: { since: 10 } }],
      })}\n`,
    );
    const p2 = readTranscriptActivityTail(dir, conv);
    assert.equal(p2.status, 'waiting');
    assert.equal(p2.tool, 'swarm_wait');
    assert.equal(p2.label, 'Waiting for posts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizePlan flattens native, fleet, and hybrid plan.json safely and never returns an object goal', () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan([]), null);

  const nativeRaw = {
    goal: {
      title: 'Cycle 2 Wave E1',
      line: 'Launch Fleet Native Plan Editor and OpenBell Shadow Runner.',
    },
    tasks: {
      'e1-fleet-be': 'Zone A backend',
      'e1-fleet-fe': 'Zone B frontend',
    },
    threads: [
      {
        id: 't-fleet',
        title: 'Fleet E1',
        goal: 'Fix crash + live editor',
        tasks: ['e1-fleet-be', 'e1-fleet-fe'],
      },
    ],
  };
  const nativeNorm = normalizePlan(nativeRaw, '100:250');
  assert.equal(nativeNorm.schema, 'native');
  assert.equal(nativeNorm.etag, '100:250');
  assert.equal(nativeNorm.title, 'Cycle 2 Wave E1');
  assert.equal(nativeNorm.goal, 'Launch Fleet Native Plan Editor and OpenBell Shadow Runner.');
  assert.equal(nativeNorm.goalTitle, 'Cycle 2 Wave E1');
  assert.equal(nativeNorm.goalLine, 'Launch Fleet Native Plan Editor and OpenBell Shadow Runner.');
  assert.equal(nativeNorm.gate, '');
  assert.deepEqual(nativeNorm.tasks, nativeRaw.tasks);
  assert.deepEqual(nativeNorm.threads, nativeRaw.threads);
  assert.deepEqual(nativeNorm.workstreams, []);
  assert.deepEqual(nativeNorm.milestones, []);
  assert.deepEqual(nativeNorm.risks, []);

  // Goal object with title only falls back cleanly to goalTitle
  const titleOnly = normalizePlan({ goal: { title: 'Title Only Goal' }, tasks: {}, threads: [] }, '200:40');
  assert.equal(titleOnly.goal, 'Title Only Goal');
  assert.equal(titleOnly.title, 'Title Only Goal');

  // Fleet schema
  const fleetNorm = normalizePlan(
    {
      title: 'Fleet Release',
      goal: 'Ship v1.20',
      gate: 'npm test',
      repo: '/repo/fleet',
      workstreams: [{ id: 'ws-1', title: 'BE', owner: 'worker', status: 'in_progress', note: 'active' }],
      milestones: [{ title: 'Alpha', status: 'verified' }],
      risks: ['Legacy risk', { title: 'Race condition', severity: 'high' }],
    },
    '300:180',
  );
  assert.equal(fleetNorm.schema, 'fleet');
  assert.equal(fleetNorm.workstreams[0].status, 'running');
  assert.equal(fleetNorm.milestones[0].status, 'done');
  assert.deepEqual(fleetNorm.risks, [{ title: 'Legacy risk' }, { title: 'Race condition', severity: 'high' }]);

  // Hybrid schema when native + fleet fields coexist
  const hybridNorm = normalizePlan({ ...nativeRaw, gate: 'npm test', workstreams: [{ id: 'ws-1', title: 'BE', owner: 'e1-fleet-be', status: 'done' }] }, '400:300');
  assert.equal(hybridNorm.schema, 'hybrid');
  assert.equal(typeof hybridNorm.goal, 'string');
  assert.equal(hybridNorm.workstreams.length, 1);
});

test('buildSwarmSnapshot exposes normalized native plan.json and narrator view.json, and writeSwarmPlan performs atomic CAS', () => {
  const dir = makeScratchDir('native-plan-');
  try {
    const coordId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const narratorId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const swarmPath = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const narratorViewDir = join(dir, 'brain', narratorId, 'swarm_view');
    mkdirSync(swarmPath, { recursive: true });
    mkdirSync(narratorViewDir, { recursive: true });

    writeFileSync(
      join(swarmPath, 'members.json'),
      JSON.stringify({
        title: 'Native Swarm',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', last_read_seq: 1 },
          narrator: { conversation_id: narratorId, role: 'narrator', last_read_seq: 1 },
        },
      }),
    );
    writeFileSync(join(swarmPath, 'board.jsonl'), JSON.stringify({ seq: 1, agent: 'coordinator', text: 'Go' }) + '\n');

    writeFileSync(
      join(narratorViewDir, 'view.json'),
      JSON.stringify({
        headline: 'Wave E1 underway',
        phase: 'build',
        running_summary: 'Zone A & B active',
        now: { coordinator: 'Coordinating batch 1' },
        attention: [{ id: 'att-1', severity: 'info', title: 'No blockers' }],
        feedback_ack: 'ack-42',
      }),
    );

    // Absent plan.json yields null plan and listSwarms hasPlan=false
    const snap0 = buildSwarmSnapshot(dir, coordId);
    assert.equal(snap0.plan, null);
    assert.equal(snap0.view.source, 'narrator');
    assert.equal(snap0.view.json.headline, 'Wave E1 underway');
    assert.equal(snap0.view.json.phase, 'build');
    assert.equal(snap0.view.json.running_summary, 'Zone A & B active');
    assert.equal(snap0.view.json.now.coordinator, 'Coordinating batch 1');
    assert.equal(snap0.view.json.attention.length, 1);
    assert.equal(snap0.view.json.feedback_ack, 'ack-42');
    assert.equal(listSwarms([dir])[0].hasPlan, false);

    // Write native plan.json externally and verify snapshot normalization
    const nativeOnDisk = {
      goal: { title: 'Native Title', line: 'Native Line' },
      tasks: { worker1: 'Implement feature' },
      threads: [{ id: 't-1', title: 'Thread 1', goal: 'Deliver', tasks: ['worker1'] }],
      customNativeMeta: { wave: 2 },
    };
    writeFileSync(join(swarmPath, 'plan.json'), JSON.stringify(nativeOnDisk));
    const snap1 = buildSwarmSnapshot(dir, coordId);
    assert.equal(snap1.plan.schema, 'native');
    assert.equal(snap1.plan.goal, 'Native Line');
    assert.equal(snap1.plan.goalTitle, 'Native Title');
    assert.equal(snap1.plan.goalLine, 'Native Line');
    assert.ok(snap1.plan.etag.includes(':'));
    assert.equal(listSwarms([dir])[0].hasPlan, true);

    // CAS mismatch returns 409 with latest normalized plan
    const conflict = writeSwarmPlan(dir, coordId, {
      ifMatch: 'stale:0',
      mode: 'patch',
      patch: { gate: 'npm test' },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.plan.etag, snap1.plan.etag);

    // Patch native plan with Fleet gate/workstreams while preserving native fields on disk
    const patched = writeSwarmPlan(dir, coordId, {
      ifMatch: snap1.plan.etag,
      mode: 'patch',
      patch: {
        goalLine: 'Updated Native Line',
        gate: 'npm test',
        workstreams: [{ id: 'ws-1', title: 'Backend', owner: 'worker1', status: 'done' }],
      },
    });
    assert.equal(patched.ok, true);
    assert.equal(patched.plan.schema, 'hybrid');
    assert.equal(patched.plan.goal, 'Updated Native Line');
    assert.equal(patched.plan.goalTitle, 'Native Title');
    assert.notEqual(patched.etag, snap1.plan.etag);

    const diskAfterPatch = JSON.parse(readFileSync(join(swarmPath, 'plan.json'), 'utf-8'));
    assert.deepEqual(diskAfterPatch.goal, { title: 'Native Title', line: 'Updated Native Line' });
    assert.deepEqual(diskAfterPatch.tasks, { worker1: 'Implement feature' });
    assert.equal(diskAfterPatch.threads.length, 1);
    assert.deepEqual(diskAfterPatch.customNativeMeta, { wave: 2 });
    assert.equal(diskAfterPatch.gate, 'npm test');

    // Mode replace on native/hybrid preserves unknown native fields & goal.{title,line}
    const replaced = writeSwarmPlan(dir, coordId, {
      ifMatch: patched.etag,
      mode: 'replace',
      patch: {
        goal: 'Replaced Line',
        workstreams: [{ id: 'ws-1', title: 'Backend', owner: 'worker1', status: 'verified' }],
      },
    });
    assert.equal(replaced.ok, true);
    const diskAfterReplace = JSON.parse(readFileSync(join(swarmPath, 'plan.json'), 'utf-8'));
    assert.deepEqual(diskAfterReplace.goal, { title: 'Native Title', line: 'Replaced Line' });
    assert.deepEqual(diskAfterReplace.customNativeMeta, { wave: 2 });
    assert.equal(diskAfterReplace.gate, undefined);
    assert.equal(diskAfterReplace.workstreams[0].status, 'verified');

    // Control-char and symlink escape rejections
    const badCtrl = writeSwarmPlan(dir, coordId, {
      ifMatch: replaced.etag,
      mode: 'patch',
      patch: { gate: 'npm\x00test' },
    });
    assert.equal(badCtrl.ok, false);
    assert.equal(badCtrl.status, 400);

    const outsidePlan = join(dir, 'outside-plan.json');
    writeFileSync(outsidePlan, '{}');
    rmSync(join(swarmPath, 'plan.json'));
    symlinkSync(outsidePlan, join(swarmPath, 'plan.json'));
    const symlinkRes = writeSwarmPlan(dir, coordId, {
      ifMatch: '',
      mode: 'patch',
      patch: { gate: 'npm test' },
    });
    assert.equal(symlinkRes.ok, false);
    assert.equal(symlinkRes.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git_probe enriches branchFiles, commits, mergeability, collisions (working/branch/mixed), and detached worktrees', async () => {
  const baseDir = makeScratchDir('gitprobe-e2-');
  const repoDir = join(baseDir, 'repo');
  const wtA = join(baseDir, 'wt-a');
  const wtB = join(baseDir, 'wt-b');
  const wtDet = join(baseDir, 'wt-det');
  try {
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    writeFileSync(join(repoDir, 'shared.txt'), 'line 1\n');
    writeFileSync(join(repoDir, 'work.txt'), 'work base\n');
    writeFileSync(join(repoDir, 'mix.txt'), 'mix base\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Initial'], { stdio: 'ignore' });

    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/a', wtA], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/b', wtB], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', wtDet, 'HEAD'], { stdio: 'ignore' });

    // Committed changes on feat/a: shared.txt + mix.txt (7 commits -> capped at 5)
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(wtA, 'shared.txt'), `feat-a v${i}\n`);
      execFileSync('git', ['-C', wtA, 'commit', '-am', `feat-a commit ${i}`], { stdio: 'ignore' });
    }
    writeFileSync(join(wtA, 'mix.txt'), 'feat-a mix\n');
    execFileSync('git', ['-C', wtA, 'commit', '-am', 'feat-a mix commit'], { stdio: 'ignore' });

    // Advance main on shared.txt so feat/a has a merge-tree conflict while feat/b is clean
    writeFileSync(join(repoDir, 'shared.txt'), 'main diverged\n');
    execFileSync('git', ['-C', repoDir, 'commit', '-am', 'Main diverged shared'], { stdio: 'ignore' });

    // Committed change on feat/b: shared.txt (branch collision with feat/a)
    writeFileSync(join(wtB, 'shared.txt'), 'feat-b branch\n');
    execFileSync('git', ['-C', wtB, 'commit', '-am', 'feat-b commit'], { stdio: 'ignore' });

    // Working dirty changes: work.txt in both wtA & wtB (working collision); mix.txt dirty in wtB (mixed collision with wtA's branchFile)
    writeFileSync(join(wtA, 'work.txt'), 'wtA dirty\n');
    writeFileSync(join(wtB, 'work.txt'), 'wtB dirty\n');
    writeFileSync(join(wtB, 'mix.txt'), 'wtB dirty mix\n');

    const dirtyProbe = await probeWorktrees([repoDir], { ttlMs: 0 });
    const mainWt = dirtyProbe.worktrees.find((w) => w.isMain);
    const detWt = dirtyProbe.worktrees.find((w) => w.detached);
    const aWt = dirtyProbe.worktrees.find((w) => w.branch === 'feat/a');
    const bWt = dirtyProbe.worktrees.find((w) => w.branch === 'feat/b');

    assert.equal(mainWt?.mergeability, 'main');
    assert.equal(detWt?.mergeability, 'detached');
    assert.equal(aWt?.mergeability, 'dirty');
    assert.equal(bWt?.mergeability, 'dirty');
    assert.equal(aWt?.commits.length, 5);
    assert.equal(aWt?.commits[0].subject, 'feat-a mix commit');
    assert.ok(aWt?.commits[0].sha && typeof aWt?.commits[0].authorTime === 'string' && aWt.commits[0].authorTime.length > 0);
    assert.deepEqual(aWt?.branchFiles.sort(), ['mix.txt', 'shared.txt']);

    const byFile = Object.fromEntries(dirtyProbe.collisions.map((c) => [c.file, c]));
    assert.equal(byFile['shared.txt']?.kind, 'branch');
    assert.equal(byFile['shared.txt']?.worktrees.length, 2);
    assert.equal(byFile['work.txt']?.kind, 'working');
    assert.equal(byFile['mix.txt']?.kind, 'mixed');

    // Clean wtA and check mergeability === 'conflict' + conflictFiles
    execFileSync('git', ['-C', wtA, 'checkout', '--', 'work.txt'], { stdio: 'ignore' });
    const cleanAProbe = await probeWorktrees([repoDir], { ttlMs: 0 });
    const aClean = cleanAProbe.worktrees.find((w) => w.branch === 'feat/a');
    assert.equal(aClean?.mergeability, 'conflict');
    assert.deepEqual(aClean?.conflictFiles, ['shared.txt']);

    // mode=branch vs mode=working diff via path-only confinement
    const branchDiff = await probeWorktreeDiff({ path: wtA, file: 'shared.txt', mode: 'branch' });
    assert.equal(branchDiff.ok, true);
    assert.equal(branchDiff.mode, 'branch');
    assert.ok(branchDiff.diff.includes('+feat-a v6'));

    const workingDiff = await probeWorktreeDiff({ path: wtA, file: 'shared.txt', mode: 'working' });
    assert.equal(workingDiff.ok, true);
    assert.equal(workingDiff.diff, '');

    // Reject path traversal & direct unit action checks
    const badMode = await probeWorktreeDiff({ path: wtA, file: 'shared.txt', mode: 'bogus' });
    assert.equal(badMode.ok, false);
    assert.equal(badMode.status, 400);

    const rmMain = await executeWorktreeAction({ action: 'remove_worktree', path: repoDir });
    assert.equal(rmMain.ok, false);
    assert.equal(rmMain.httpStatus, 400);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildSwarmSnapshot computes replyRefs citations and findCoordinatorConvId resolves coordinator across forms', () => {
  const dir = makeScratchDir('reply-refs-');
  try {
    const coordId = '11112222-3333-4444-8555-666677778888';
    const workerId = '99992222-3333-4444-8555-666677778888';
    const swarmPath = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swarmPath, { recursive: true });

    const rosterObj = {
      title: 'Reply Refs Swarm',
      members: {
        coordinator: { conversation_id: coordId, role: 'coordinator', last_read_seq: 5 },
        builder: { conversation_id: workerId, role: 'worker', last_read_seq: 5 },
      },
    };
    writeFileSync(join(swarmPath, 'members.json'), JSON.stringify(rosterObj));

    writeFileSync(
      join(swarmPath, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', text: 'Create #backend', control: { op: 'create', channel: 'backend' } }),
        JSON.stringify({ seq: 2, agent: 'coordinator', text: '@builder Start work on API' }),
        JSON.stringify({ seq: 3, agent: 'builder', text: 'Re #2: API started, ignoring #1, #999, foo#2, and self #3' }),
        JSON.stringify({ seq: 4, agent: 'coordinator', text: 'Verified #2 and #3; re-checking #2' }),
        JSON.stringify({ seq: 5, agent: 'builder', text: 'Follow-up note', replyToSeq: 3 }),
      ].join('\n') + '\n',
    );

    const snap = buildSwarmSnapshot(dir, coordId);
    assert.ok(snap);
    assert.deepEqual(snap.replyRefs, {
      2: [3, 4],
      3: [4, 5],
    });

    assert.equal(findCoordinatorConvId(dir, coordId), coordId);
    assert.equal(findCoordinatorConvId(swarmPath), coordId);
    assert.equal(findCoordinatorConvId(rosterObj), coordId);
    assert.equal(findCoordinatorConvId(rosterObj.members), coordId);
    assert.equal(findCoordinatorConvId(snap.members), coordId);

    // Missing or killed coordinator returns null
    assert.equal(findCoordinatorConvId({ builder: { conversation_id: workerId, role: 'worker' } }), null);
    assert.equal(findCoordinatorConvId({ coordinator: { conversation_id: coordId, role: 'coordinator', killed: true } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeMemberWorktree reports dirtyFiles and ahead commits accurately', async () => {
  const baseDir = makeScratchDir('member-wt-');
  const repoDir = join(baseDir, 'repo');
  const wtDir = join(baseDir, 'wt-builder');
  try {
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Initial'], { stdio: 'ignore' });

    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/builder', wtDir], { stdio: 'ignore' });
    const cleanProbe = await probeMemberWorktree(wtDir);
    assert.equal(cleanProbe.ok, true);
    assert.equal(cleanProbe.isMain, false);
    assert.equal(cleanProbe.dirtyFiles, 0);
    assert.equal(cleanProbe.ahead, 0);

    writeFileSync(join(wtDir, 'committed.txt'), 'ahead commit\n');
    execFileSync('git', ['-C', wtDir, 'add', 'committed.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', wtDir, 'commit', '-m', 'Ahead commit'], { stdio: 'ignore' });
    writeFileSync(join(wtDir, 'untracked.txt'), 'dirty\n');

    const dirtyProbe = await probeMemberWorktree(wtDir);
    assert.equal(dirtyProbe.ok, true);
    assert.equal(dirtyProbe.dirtyFiles, 1);
    assert.equal(dirtyProbe.ahead, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildSwarmSnapshot recovers from corrupt/truncated JSONL, malformed plan/view, and non-primitive fields', () => {
  const dir = makeScratchDir('corrupt-recovery-');
  try {
    const coordId = '1111aaaa-1111-4111-8111-111111111111';
    const workerId = '2222bbbb-2222-4222-8222-222222222222';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const logDir = join(dir, 'brain', workerId, '.system_generated', 'logs');
    mkdirSync(swDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({
        title: 'Corrupt Recovery Swarm',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', last_read_seq: 1 },
          worker: { conversation_id: workerId, role: 'worker', channels: ['main', 123], last_read_seq: 0 },
          badconv: { conversation_id: 999, role: 'worker' },
        },
      }),
    );

    // Mix valid lines, mid-file corrupt JSON, primitive JSON lines, objects with non-primitive fields, and trailing torn line
    writeFileSync(
      join(swDir, 'board.jsonl'),
      [
        '{"seq": 1, "agent": "coordinator", "text": "@worker start", "time": "2026-11-26 10:00:00"}',
        '{corrupt mid-file line',
        'null',
        '[1, 2, 3]',
        '"just a string"',
        '{"seq": "1e999", "agent": {"toString": 1}, "text": {"toString": 1}, "time": {"toString": 1}}',
        '{"seq": 2, "agent": "worker", "text": "Re #1: recovered cleanly", "time": "2026-11-26 10:01:00"}',
        '{"seq": 3, "agent": "worker", "text": "trailing truncated',
      ].join('\n'),
    );

    writeFileSync(
      join(logDir, 'transcript.jsonl'),
      [
        '{broken_start_line',
        JSON.stringify({ step_index: 0, type: { toString: 1 }, status: { toString: 1 }, tool_calls: [null, { name: { toString: 1 }, args: { toolSummary: { toString: 1 } } }] }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 300, output_tokens: 50, tool_calls: [{ name: 'read_file', args: { Path: '/tmp/ok.ts' } }] }),
        '{"step_index": 2, "type": "PLANNER_RESPONSE", "broken_tail',
      ].join('\n'),
    );

    // Malformed plan.json and malformed view.json
    writeFileSync(join(swDir, 'plan.json'), '{not valid json');
    writeFileSync(join(swDir, 'view.json'), '{"headline": "ok", ');

    const snap1 = buildSwarmSnapshot(dir, coordId);
    assert.ok(snap1);
    assert.equal(snap1.plan, null);
    assert.equal(snap1.view.jsonError, 'invalid');
    assert.equal(snap1.view.json, null);
    assert.equal(snap1.messages.length, 3);
    assert.equal(snap1.head, 2);
    assert.equal(snap1.usage.totalTokens, 350);

    // Valid view.json followed by transient corrupt write preserves last-good view.json
    writeFileSync(join(swDir, 'view.json'), JSON.stringify({ headline: 'Last good view', phase: 'verify' }));
    const snapGoodView = buildSwarmSnapshot(dir, coordId);
    assert.equal(snapGoodView.view.json?.headline, 'Last good view');
    assert.equal(snapGoodView.view.jsonError, '');

    writeFileSync(join(swDir, 'view.json'), '{"corrupt": ');
    const snapFallbackView = buildSwarmSnapshot(dir, coordId);
    assert.equal(snapFallbackView.view.json?.headline, 'Last good view');
    assert.equal(snapFallbackView.view.jsonError, 'invalid');

    // Control characters on disk in plan.json are stripped by normalizePlan
    const cleanFromCorrupt = normalizePlan({
      title: 'Title\x07\nWith\x1bCtrl',
      goal: 'Goal\x00line',
      tasks: { a: { toString: 1 }, b: 'ok\x07' },
      threads: [{ id: 't-1\n', title: 'T\x07', goal: { line: 'G\x00' }, tasks: ['a', 42] }],
      workstreams: [{ id: 'ws-1\n', title: 'W\x07', owner: 'worker\n', status: 'in_progress' }],
    }, '1:1');
    assert.equal(cleanFromCorrupt.title, 'Title WithCtrl');
    assert.equal(cleanFromCorrupt.goal, 'Goalline');
    assert.equal(cleanFromCorrupt.tasks.b, 'ok');
    assert.equal(cleanFromCorrupt.workstreams[0].owner, 'worker');
    assert.equal(cleanFromCorrupt.workstreams[0].status, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSwarmPlan sanitizes unknown/corrupt fields and detects same-size CAS conflicts via content hash', () => {
  const dir = makeScratchDir('plan-sanitize-');
  try {
    const coordId = '3333cccc-3333-4333-8333-333333333333';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swDir, { recursive: true });
    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({ title: 'Plan Sanitize', members: { coordinator: { conversation_id: coordId, role: 'coordinator' } } }),
    );
    // Corrupt non-array workstreams on disk initially
    writeFileSync(join(swDir, 'plan.json'), JSON.stringify({ title: 'Init', workstreams: 'corrupt-type' }));
    const snap0 = buildSwarmSnapshot(dir, coordId);
    assert.ok(snap0.plan.etag);

    // Patch strips unknown top-level keys and drops corrupt non-array base workstreams
    const w1 = writeSwarmPlan(dir, coordId, {
      ifMatch: snap0.plan.etag,
      mode: 'patch',
      patch: {
        title: 'Clean\nTitle',
        gate: 'npm\ntest',
        unknownEvilField: 'dropped',
        etag: 'spoofed',
        schema: 'spoofed',
        workstreams: [{ id: 'ws-1', title: 'Hardening', owner: 'be', status: 'done' }],
      },
    });
    assert.equal(w1.ok, true);
    assert.equal(w1.plan.title, 'Clean Title');
    assert.equal(w1.plan.gate, 'npm test');
    const rawDisk1 = JSON.parse(readFileSync(join(swDir, 'plan.json'), 'utf8'));
    assert.equal(rawDisk1.unknownEvilField, undefined);
    assert.equal(rawDisk1.etag, undefined);
    assert.equal(rawDisk1.schema, undefined);

    // Same-length modification changes content-hash etag even within same ms tick
    const w2 = writeSwarmPlan(dir, coordId, {
      ifMatch: w1.etag,
      mode: 'patch',
      patch: { title: 'Clean\nTitl2' },
    });
    assert.equal(w2.ok, true);
    assert.notEqual(w2.etag, w1.etag);

    // Prototype keys & C1 controls rejected
    assert.equal(writeSwarmPlan(dir, coordId, { ifMatch: w2.etag, patch: JSON.parse('{"__proto__":{"polluted":true}}') }).status, 400);
    assert.equal(writeSwarmPlan(dir, coordId, { ifMatch: w2.etag, patch: { gate: 'bad\x85c1' } }).status, 400);
    assert.equal(writeSwarmPlan(dir, coordId, { ifMatch: 'bad\nmatch', patch: { gate: 'ok' } }).status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git_probe handles missing baseBranch, custom default branch, huge diffs, symlink CWE-59, and action edge cases', async () => {
  const baseDir = makeScratchDir('gitprobe-h1-');
  const trunkRepo = join(baseDir, 'trunk-repo');
  const trunkWt = join(baseDir, 'trunk-wt');
  const detRepo = join(baseDir, 'det-repo');
  const detWt = join(baseDir, 'det-wt');
  const lockedWt = join(baseDir, 'locked-wt');
  const symWt = join(baseDir, 'sym-wt');
  const outsideDir = join(baseDir, 'outside');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');

  try {
    // 1. Repo with custom default branch 'trunk' (no main/master)
    execFileSync('git', ['init', '-b', 'trunk', trunkRepo], { stdio: 'ignore' });
    execFileSync('git', ['-C', trunkRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', trunkRepo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    writeFileSync(join(trunkRepo, 'big.txt'), 'init\n');
    execFileSync('git', ['-C', trunkRepo, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', trunkRepo, 'commit', '-m', 'Initial trunk'], { stdio: 'ignore' });

    execFileSync('git', ['-C', trunkRepo, 'worktree', 'add', '-b', 'feat/huge', trunkWt], { stdio: 'ignore' });
    execFileSync('git', ['-C', trunkRepo, 'worktree', 'add', '-b', 'feat/locked', lockedWt], { stdio: 'ignore' });
    execFileSync('git', ['-C', trunkRepo, 'worktree', 'lock', lockedWt], { stdio: 'ignore' });

    // Huge > 2.5 MB diff (exceeds old 2 MB maxBuffer) on feat/huge
    const hugeBody = Array.from({ length: 45000 }, (_, i) => `line-${i}-${'x'.repeat(50)}`).join('\n') + '\n';
    writeFileSync(join(trunkWt, 'big.txt'), hugeBody);
    execFileSync('git', ['-C', trunkWt, 'commit', '-am', 'Huge diff commit'], { stdio: 'ignore' });

    const trunkProbe = await probeWorktrees([trunkRepo], { ttlMs: 0 });
    const hugeWtInfo = trunkProbe.worktrees.find((w) => w.branch === 'feat/huge');
    assert.equal(hugeWtInfo?.baseBranch, 'trunk');
    assert.equal(hugeWtInfo?.ahead, 1);

    const hugeBranchDiff = await probeWorktreeDiff({ path: trunkWt, file: 'big.txt', mode: 'branch' });
    assert.equal(hugeBranchDiff.ok, true);
    assert.equal(hugeBranchDiff.truncated, true);
    assert.ok(hugeBranchDiff.diff.includes('line-0-'));
    assert.ok(Buffer.byteLength(hugeBranchDiff.diff, 'utf8') <= 8192);

    // Working huge diff too (> 2.5 MB working change)
    writeFileSync(join(trunkWt, 'big.txt'), hugeBody.replaceAll('line-', 'mod-'));
    const hugeWorkDiff = await probeWorktreeDiff({ path: trunkWt, file: 'big.txt', mode: 'working' });
    assert.equal(hugeWorkDiff.ok, true);
    assert.equal(hugeWorkDiff.truncated, true);
    assert.ok(hugeWorkDiff.diff.includes('-line-0-'));
    assert.ok(Buffer.byteLength(hugeWorkDiff.diff, 'utf8') <= 8192);
    execFileSync('git', ['-C', trunkWt, 'checkout', '--', 'big.txt'], { stdio: 'ignore' });

    // 2. Symlinked worktree path CWE-59 guards (with and without trailing slash) + dangling symlink + conflicting params
    symlinkSync(trunkWt, symWt);
    const symProbe = await probeWorktrees([symWt, `${symWt}/`], { ttlMs: 0 });
    assert.equal(symProbe.rejected.length, 2);
    assert.equal(symProbe.worktrees.length, 0);

    const symDiff = await probeWorktreeDiff({ path: `${symWt}/`, file: 'big.txt' });
    assert.equal(symDiff.ok, false);
    assert.equal(symDiff.status, 400);

    const symAction = await executeWorktreeAction({ action: 'remove_worktree', path: symWt });
    assert.equal(symAction.ok, false);
    assert.equal(symAction.httpStatus, 400);

    const symMember = await probeMemberWorktree(symWt);
    assert.equal(symMember.ok, false);

    // Dangling symlink and dangling parent symlink inside worktree
    symlinkSync('/nonexistent/outside/secret', join(trunkWt, 'dangling-link'));
    const danglingDiff = await probeWorktreeDiff({ path: trunkWt, file: 'dangling-link' });
    assert.equal(danglingDiff.ok, false);
    assert.equal(danglingDiff.status, 404);
    rmSync(join(trunkWt, 'dangling-link'));

    symlinkSync('/nonexistent/outside/dir', join(trunkWt, 'dangling-dir'));
    const danglingParentDiff = await probeWorktreeDiff({ path: trunkWt, file: 'dangling-dir/passwd' });
    assert.equal(danglingParentDiff.ok, false);
    assert.equal(danglingParentDiff.status, 404);
    rmSync(join(trunkWt, 'dangling-dir'));

    // Conflicting worktree vs path
    const conflictParams = await probeWorktreeDiff({ worktree: trunkWt, path: lockedWt, file: 'big.txt' });
    assert.equal(conflictParams.ok, false);
    assert.equal(conflictParams.status, 400);

    // 3. Action edge cases: locked worktree, in-progress rebase preservation
    const lockedRm = await executeWorktreeAction({ action: 'remove_worktree', path: lockedWt });
    assert.equal(lockedRm.ok, false);
    assert.equal(lockedRm.httpStatus, 409);
    assert.equal(lockedRm.payload.status, 'locked');

    // Simulate external in-progress rebase marker -> must fail 409 in_progress without aborting it
    const rebaseMergeDir = execFileSync('git', ['-C', trunkWt, 'rev-parse', '--git-path', 'rebase-merge'], { encoding: 'utf8' }).trim();
    const absRebaseDir = join(trunkWt, rebaseMergeDir).includes(baseDir) ? rebaseMergeDir : join(trunkWt, rebaseMergeDir);
    mkdirSync(absRebaseDir, { recursive: true });
    const inProgRebase = await executeWorktreeAction({ action: 'rebase', path: trunkWt });
    assert.equal(inProgRebase.ok, false);
    assert.equal(inProgRebase.httpStatus, 409);
    assert.equal(inProgRebase.payload.status, 'in_progress');
    rmSync(absRebaseDir, { recursive: true, force: true });

    // 4. Missing baseBranch (detached HEAD root with no main/master)
    execFileSync('git', ['init', '-b', 'custom', detRepo], { stdio: 'ignore' });
    execFileSync('git', ['-C', detRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', detRepo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    writeFileSync(join(detRepo, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', detRepo, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', detRepo, 'commit', '-m', 'Init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', detRepo, 'checkout', '--detach'], { stdio: 'ignore' });
    execFileSync('git', ['-C', detRepo, 'branch', '-D', 'custom'], { stdio: 'ignore' });
    execFileSync('git', ['-C', detRepo, 'worktree', 'add', '-b', 'feat/no-base', detWt], { stdio: 'ignore' });

    const detProbe = await probeWorktrees([detRepo], { ttlMs: 0 });
    const noBaseWt = detProbe.worktrees.find((w) => w.branch === 'feat/no-base');
    assert.equal(noBaseWt?.baseBranch, '');
    assert.equal(noBaseWt?.mergeability, 'unknown');

    const noBaseAction = await executeWorktreeAction({ action: 'dry_run_merge', path: detWt });
    assert.equal(noBaseAction.ok, false);
    assert.equal(noBaseAction.httpStatus, 400);
    assert.equal(noBaseAction.payload.status, 'no_base');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildSwarmDelta handles full, unchanged, append-only incremental delta, torn line completion, and truncation/rotation fallback', () => {
  const dir = makeScratchDir('delta-store-');
  try {
    const coordId = '4444dddd-4444-4444-8444-444444444444';
    const workerId = '5555eeee-5555-4555-8555-555555555555';
    const verifierId = '6666ffff-6666-4666-8666-666666666666';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const workerLogDir = join(dir, 'brain', workerId, '.system_generated', 'logs');
    mkdirSync(swDir, { recursive: true });
    mkdirSync(workerLogDir, { recursive: true });

    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({
        title: 'Delta Store Swarm',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', last_read_seq: 1 },
          builder: { conversation_id: workerId, role: 'worker', model: 'gemini-3-pro', last_read_seq: 1 },
          verifier: { conversation_id: verifierId, role: 'worker', last_read_seq: 0 },
        },
      }),
    );

    const boardPath = join(swDir, 'board.jsonl');
    writeFileSync(
      boardPath,
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder Start delta task', time: '2026-11-26 10:00:00' }) + '\n',
    );
    writeFileSync(
      join(workerLogDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 400, output_tokens: 50 }) + '\n',
    );

    // 1. since === 0 -> mode: "full"
    const full0 = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 0 });
    assert.equal(full0.ok, true);
    assert.equal(full0.mode, 'full');
    assert.equal(full0.unchanged, false);
    assert.equal(full0.head, 1);
    assert.equal(full0.messages.length, 1);
    const tail0 = getBoardTailStats(dir, coordId);
    assert.ok(tail0 && tail0.size > 0);
    assert.equal(tail0.head, 1);

    // 2. Matching etag -> unchanged: true
    const same = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 1, prevEtag: full0.etag });
    assert.deepEqual(
      { ok: same.ok, unchanged: same.unchanged, etag: same.etag, head: same.head },
      { ok: true, unchanged: true, etag: full0.etag, head: 1 },
    );

    // 3. Append-only growth + torn trailing line
    const line2 = JSON.stringify({
      seq: 2,
      agent: 'builder',
      text: '@verifier [done] Re #1: implemented delta store',
      time: '2026-11-26 10:01:00',
    });
    const torn3 = '{"seq":3,"agent":"verifier","text":"@coordinator [verified]';
    appendFileSync(boardPath, line2 + '\n' + torn3);

    const delta1 = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 1, prevEtag: full0.etag });
    assert.equal(delta1.ok, true);
    assert.equal(delta1.mode, 'delta');
    assert.equal(delta1.unchanged, false);
    assert.equal(delta1.since, 1);
    assert.equal(delta1.head, 2);
    assert.equal(delta1.messagesDelta.length, 1);
    assert.equal(delta1.messagesDelta[0].seq, 2);
    assert.deepEqual(delta1.replyRefsDelta, { 1: [2] });
    assert.equal(delta1.edgesDelta.length, 1);
    assert.deepEqual(delta1.edgesDelta[0], { from: 'builder', to: 'verifier', count: 1, direct: 1, viaAll: 0 });
    assert.equal(delta1.triage.some((t) => t.kind === 'verify' && t.seq === 2), true);
    assert.equal(delta1.gateReadiness?.state, 'verifying');
    const tail1 = getBoardTailStats(dir, coordId);
    assert.equal(tail1.ino, tail0.ino);
    assert.ok(tail1.size > tail0.size);

    // 4. Complete torn line 3 -> incremental tail resumes from carryBuf without re-reading earlier bytes
    appendFileSync(boardPath, ' Re #2: all checks pass","time":"2026-11-26 10:02:00"}\n');
    const delta2 = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 2, prevEtag: delta1.etag });
    assert.equal(delta2.ok, true);
    assert.equal(delta2.mode, 'delta');
    assert.equal(delta2.head, 3);
    assert.equal(delta2.messagesDelta.length, 1);
    assert.equal(delta2.messagesDelta[0].seq, 3);
    assert.deepEqual(delta2.replyRefsDelta, { 2: [3] });
    assert.equal(delta2.triage.some((t) => t.kind === 'verify'), false);
    const tail2 = getBoardTailStats(dir, coordId);
    assert.equal(tail2.ino, tail1.ino);
    assert.ok(tail2.size > tail1.size);

    // 5. Transcript-only append -> mode: "delta" with empty messagesDelta and updated usage
    appendFileSync(
      join(workerLogDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 600, output_tokens: 150 }) + '\n',
    );
    const delta3 = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 3, prevEtag: delta2.etag });
    assert.equal(delta3.ok, true);
    assert.equal(delta3.mode, 'delta');
    assert.equal(delta3.messagesDelta.length, 0);
    assert.deepEqual(delta3.replyRefsDelta, {});
    assert.deepEqual(delta3.edgesDelta, []);
    assert.equal(delta3.usage.totalTokens, 1200);

    // 5b. Repeated edge (builder -> verifier again) emits incremental edgesDelta (count: 1, not cumulative 2)
    appendFileSync(
      boardPath,
      JSON.stringify({ seq: 4, agent: 'builder', text: '@verifier follow-up', time: '2026-11-26 10:03:00' }) + '\n',
    );
    const delta4 = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 3, prevEtag: delta3.etag });
    assert.equal(delta4.ok, true);
    assert.equal(delta4.mode, 'delta');
    assert.equal(delta4.head, 4);
    assert.deepEqual(delta4.edgesDelta, [{ from: 'builder', to: 'verifier', count: 1, direct: 1, viaAll: 0 }]);

    // 6. Truncation -> mode: "full" fallback
    writeFileSync(
      boardPath,
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder Fresh truncated board', time: '2026-11-26 10:05:00' }) + '\n',
    );
    const truncFull = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 4, prevEtag: delta4.etag });
    assert.equal(truncFull.ok, true);
    assert.equal(truncFull.mode, 'full');
    assert.equal(truncFull.head, 1);
    assert.equal(truncFull.messages.length, 1);

    // 7. File rotation (different inode) -> mode: "full" fallback
    const rotatedTmp = join(swDir, 'board.jsonl.new');
    writeFileSync(
      rotatedTmp,
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder rotated 1' }),
        JSON.stringify({ seq: 2, agent: 'builder', text: '@coordinator rotated 2' }),
      ].join('\n') + '\n',
    );
    renameSync(rotatedTmp, boardPath);
    const rotFull = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 1, prevEtag: truncFull.etag });
    assert.equal(rotFull.ok, true);
    assert.equal(rotFull.mode, 'full');
    assert.equal(rotFull.head, 2);
    assert.equal(rotFull.messages.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTranscriptSteps handles backwards pagination, filters, correlation, scrubbing, truncation, and symlink/traversal confinement', () => {
  const dir = makeScratchDir('tr-inspector-');
  try {
    const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const evilId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const workerLogs = join(dir, 'brain', workerId, '.system_generated', 'logs');
    const evilLogs = join(dir, 'brain', evilId, '.system_generated', 'logs');
    mkdirSync(swDir, { recursive: true });
    mkdirSync(workerLogs, { recursive: true });
    mkdirSync(evilLogs, { recursive: true });

    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({
        title: 'Inspector Test',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator' },
          builder: { conversation_id: workerId, role: 'worker' },
          evil_symlink: { conversation_id: evilId, role: 'worker' },
          evil_trav: { conversation_id: '../../etc', role: 'worker' },
        },
      }),
    );

    const outsideSecret = join(dir, 'outside-secret.jsonl');
    writeFileSync(outsideSecret, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'SECRET' }) + '\n');
    symlinkSync(outsideSecret, join(evilLogs, 'transcript.jsonl'));

    const bigArgsVal = 'A'.repeat(2600);
    const bigStderr = 'STDERR_LINE\n' + 'X'.repeat(2800);
    const bigText = 'T'.repeat(1600);
    const secretBlock = [
      'Path /home/cayleb/Work/repo/file.ts and /Users/alice/.ssh/id_rsa',
      'Authorization: Bearer my-super-secret-jwt-token-12345',
      'OPENAI_API_KEY=sk-proj-abc1234567890xyz',
      'ghp_1234567890abcdef1234',
      'gho_abcdef1234567890abcd',
      'AIzaSyDummyGoogleApiKey123456',
      'xoxb-1234567890-abcdef1234',
      'AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtestkeydata\n-----END RSA PRIVATE KEY-----',
    ].join(' | ');

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T10:00:00Z',
        content: `Investigate ${secretBlock}`,
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:01Z',
        model: 'gemini-3-pro',
        input_tokens: 1000,
        cache_read_tokens: 200,
        output_tokens: 80,
        thinking: `Thinking ${bigText}`,
        content: '',
        tool_calls: [
          {
            name: 'run_command',
            args: {
              CommandLine: `cat /home/cayleb/.env && curl -H "Authorization: Bearer tok_987654321" https://example.com`,
              extra: bigArgsVal,
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'ERROR',
        created_at: '2026-11-26T10:00:04Z',
        content: `Created At: 2026-11-26T10:00:01Z\nCompleted At: 2026-11-26T10:00:04Z\nCommand exited with code 1\n${secretBlock}\n${bigStderr}`,
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:05Z',
        model: 'gemini-3-pro',
        input_tokens: 1500,
        cache_read_tokens: 500,
        output_tokens: 60,
        thinking: `Checking /Users/bob/app/main.ts ${secretBlock}`,
        tool_calls: [{ name: 'read_file', args: { Path: '/home/cayleb/Work/app.ts' } }],
      }),
      JSON.stringify({
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T10:00:06Z',
        content: 'Created At: 2026-11-26T10:00:05Z\nCompleted At: 2026-11-26T10:00:06Z\nFile contents OK',
      }),
      JSON.stringify({
        step_index: 5,
        type: 'ERROR_MESSAGE',
        status: 'ERROR',
        created_at: '2026-11-26T10:00:08Z',
        error: `Model failure: Bearer abcdef123456 sk-live-9876543210 /home/cayleb/secret`,
      }),
      JSON.stringify({
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:10Z',
        model: 'gemini-3-pro',
        input_tokens: 1800,
        cache_read_tokens: 600,
        output_tokens: 120,
        content: `Done ${bigText}`,
        tool_calls: [],
      }),
    ];
    writeFileSync(join(workerLogs, 'transcript.jsonl'), lines.join('\n') + '\n');

    // 1. Page 1 (limit=2, filter=all) -> steps [6, 5], hasMore=true, nextBefore=5
    const p1 = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', limit: 2, filter: 'all' });
    assert.equal(p1.ok, true);
    assert.equal(p1.member, 'builder');
    assert.equal(p1.conversationId, workerId);
    assert.equal(p1.totalSteps, 7);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.nextBefore, 5);
    assert.deepEqual(p1.steps.map((s) => s.stepIndex), [6, 5]);
    assert.ok(p1.steps[0].content.length <= 1200);
    assert.equal(p1.steps[1].type, 'ERROR_MESSAGE');
    assert.ok(!p1.steps[1].error.includes('abcdef123456'));
    assert.ok(!p1.steps[1].error.includes('sk-live-9876543210'));
    assert.ok(!p1.steps[1].error.includes('/home/cayleb'));
    assert.ok(p1.steps[1].error.includes('~/secret'));

    // 2. Page 2 (before=5, limit=2) -> steps [3, 1] (GENERIC 4 & 2 correlated into 3 & 1!)
    const p2 = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', before: p1.nextBefore, limit: 2 });
    assert.equal(p2.ok, true);
    assert.equal(p2.hasMore, true);
    assert.equal(p2.nextBefore, 1);
    assert.deepEqual(p2.steps.map((s) => s.stepIndex), [3, 1]);

    // Verify paired GENERIC correlation on step 3 and step 1
    const s3 = p2.steps[0];
    assert.equal(s3.durationMs, 1000);
    assert.equal(s3.usage.inputTokens, 1500);
    assert.equal(s3.usage.cacheReadTokens, 500);
    assert.equal(s3.usage.outputTokens, 60);
    assert.equal(s3.toolCalls[0].status, 'DONE');
    assert.ok(s3.toolCalls[0].outputPreview.includes('File contents OK'));
    assert.equal(s3.toolCalls[0].args.Path, '~/Work/app.ts');

    const s1 = p2.steps[1];
    assert.equal(s1.durationMs, 3000);
    assert.ok(s1.thinking.length <= 1200);
    assert.equal(s1.toolCalls[0].status, 'ERROR');
    assert.ok(Buffer.byteLength(JSON.stringify(s1.toolCalls[0].args), 'utf8') <= 2048);
    assert.ok(Buffer.byteLength(s1.toolCalls[0].outputPreview, 'utf8') <= 2048);
    for (const leaked of [
      '/home/cayleb',
      '/Users/alice',
      '/Users/bob',
      'my-super-secret-jwt-token-12345',
      'tok_987654321',
      'sk-proj-abc1234567890xyz',
      'ghp_1234567890abcdef1234',
      'gho_abcdef1234567890abcd',
      'AIzaSyDummyGoogleApiKey123456',
      'xoxb-1234567890-abcdef1234',
      'AKIAIOSFODNN7EXAMPLE',
      'MIIEowIBAAKCAQEAtestkeydata',
    ]) {
      assert.ok(!s1.toolCalls[0].outputPreview.includes(leaked), `Secret leaked in outputPreview: ${leaked}`);
      assert.ok(!JSON.stringify(s1.toolCalls[0].args).includes(leaked), `Secret leaked in args: ${leaked}`);
      assert.ok(!s3.thinking.includes(leaked), `Secret leaked in thinking: ${leaked}`);
    }

    // 3. Page 3 (before=1, limit=2) -> step [0], hasMore=false, nextBefore=null
    const p3 = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', before: p2.nextBefore, limit: 2 });
    assert.equal(p3.ok, true);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextBefore, null);
    assert.deepEqual(p3.steps.map((s) => s.stepIndex), [0]);
    assert.ok(!p3.steps[0].content.includes('/home/cayleb'));
    assert.ok(!p3.steps[0].content.includes('AKIAIOSFODNN7EXAMPLE'));

    // 4. filter=errors -> [5, 1] (both ERROR_MESSAGE and PLANNER_RESPONSE with failed GENERIC tool)
    const errRes = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', filter: 'errors' });
    assert.equal(errRes.ok, true);
    assert.deepEqual(errRes.steps.map((s) => s.stepIndex), [5, 1]);

    // 5. filter=tools -> [3, 1]
    const toolsRes = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', filter: 'tools' });
    assert.equal(toolsRes.ok, true);
    assert.deepEqual(toolsRes.steps.map((s) => s.stepIndex), [3, 1]);

    // 6. CWE-22 / CWE-59 rejections & invalid inputs
    assert.equal(readTranscriptSteps([dir], { conversationId: '../evil', member: 'builder' }).status, 400);
    assert.equal(readTranscriptSteps([dir], { conversationId: coordId, member: '../evil' }).status, 400);
    assert.equal(readTranscriptSteps([dir], { conversationId: coordId, member: 'unknown' }).status, 404);
    assert.equal(readTranscriptSteps([dir], { conversationId: coordId, member: 'evil_symlink' }).status, 400);
    assert.equal(readTranscriptSteps([dir], { conversationId: coordId, member: 'evil_trav' }).status, 400);
    assert.equal(readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', filter: 'bogus' }).status, 400);
    assert.equal(readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', before: -1 }).status, 400);

    // 7. Bounded >512 KiB multi-page scan + oversized (>2 MiB) line drop safety
    const bigLines = [];
    for (let i = 0; i < 600; i++) {
      bigLines.push(
        JSON.stringify({
          step_index: i,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-26T10:00:00Z',
          content: `Step ${i} ` + 'z'.repeat(1100),
          tool_calls: [],
        }),
      );
    }
    writeFileSync(join(workerLogs, 'transcript.jsonl'), bigLines.join('\n') + '\n');
    const bigP1 = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', limit: 50 });
    assert.equal(bigP1.ok, true);
    assert.equal(bigP1.steps.length, 50);
    assert.equal(bigP1.hasMore, true);
    assert.equal(bigP1.steps[0].stepIndex, 599);
    assert.equal(bigP1.nextBefore, 550);

    // Walk backwards through multiple pages past 512 KiB boundary
    let cursor = bigP1.nextBefore;
    let totalCollected = bigP1.steps.length;
    let pages = 1;
    while (cursor !== null && pages < 20) {
      const next = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', before: cursor, limit: 50 });
      assert.equal(next.ok, true);
      totalCollected += next.steps.length;
      cursor = next.nextBefore;
      pages++;
    }
    assert.equal(totalCollected, 600);
    assert.equal(cursor, null);

    // 8. Oversized (>2 MiB) corrupt line is safely dropped without crashing or heap exhaustion
    const hugeLine = JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', content: 'H'.repeat(2 * 1024 * 1024 + 512) });
    const normalLine = JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'after oversized line' });
    writeFileSync(join(workerLogs, 'transcript.jsonl'), hugeLine + '\n' + normalLine + '\n');
    const overRes = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', limit: 10 });
    assert.equal(overRes.ok, true);
    assert.deepEqual(overRes.steps.map((s) => s.stepIndex), [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getModelSpec resolves Gemini 1M, Claude 200k/[1m], OpenAI 128k/200k/400k, and safe unknown fallback', () => {
  const g4 = getModelSpec('gemini-4-hydrogen-high');
  assert.equal(g4.family, 'gemini-pro');
  assert.equal(g4.contextLimit, 1_000_000);
  assert.equal(g4.pricingKnown, true);

  const g25 = getModelSpec('gemini-2.5-pro');
  assert.equal(g25.contextLimit, 1_000_000);
  assert.equal(g25.pricingKnown, true);

  const gFlash = getModelSpec('gemini-3.8-flash-high');
  assert.equal(gFlash.family, 'gemini-flash');
  assert.equal(gFlash.contextLimit, 1_000_000);
  assert.equal(gFlash.pricingKnown, true);
  assert.ok(gFlash.outPer1M < g25.outPer1M);

  const cSonnet = getModelSpec('claude-sonnet-4-6');
  assert.equal(cSonnet.family, 'claude-sonnet');
  assert.equal(cSonnet.contextLimit, 200_000);
  assert.equal(cSonnet.pricingKnown, true);

  const cOpus = getModelSpec('claude-opus-5-5-high');
  assert.equal(cOpus.family, 'claude-opus');
  assert.equal(cOpus.contextLimit, 200_000);
  assert.equal(cOpus.pricingKnown, true);
  assert.ok(cOpus.outPer1M > cSonnet.outPer1M);

  const c1mBracket = getModelSpec('claude-sonnet-4-5[1m]');
  assert.equal(c1mBracket.family, 'claude-sonnet');
  assert.equal(c1mBracket.contextLimit, 1_000_000);
  assert.equal(c1mBracket.pricingKnown, true);

  const c1mDash = getModelSpec('claude-opus-4-6-1m');
  assert.equal(c1mDash.family, 'claude-opus');
  assert.equal(c1mDash.contextLimit, 1_000_000);
  assert.equal(c1mDash.pricingKnown, true);

  assert.equal(getModelSpec('gpt-4o').contextLimit, 128_000);
  assert.equal(getModelSpec('gpt-4o').pricingKnown, true);
  assert.equal(getModelSpec('o3-mini').contextLimit, 200_000);
  assert.equal(getModelSpec('o3-mini').pricingKnown, true);
  assert.equal(getModelSpec('gpt-5').contextLimit, 400_000);
  assert.equal(getModelSpec('gpt-5').pricingKnown, true);

  for (const bad of ['custom-local-llama', '', null, '__proto__']) {
    const u = getModelSpec(bad);
    assert.deepEqual(u, {
      family: 'unknown',
      contextLimit: 200_000,
      inPer1M: 0,
      cacheReadPer1M: 0,
      outPer1M: 0,
      pricingKnown: false,
    });
  }
});

test('summarizeTranscript and buildSwarmSnapshot preserve byModel spend across switch_model and compute 1M contextPct', () => {
  const dir = makeScratchDir('cost-switch-');
  try {
    const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const swarmPath = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const logsDir = join(dir, 'brain', workerId, '.system_generated', 'logs');
    mkdirSync(swarmPath, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    writeFileSync(
      join(swarmPath, 'members.json'),
      JSON.stringify({
        title: 'Model Switch Cost Test',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', model: 'claude-opus-4-6' },
          builder: { conversation_id: workerId, role: 'worker', model: 'gemini-4-hydrogen-high' },
        },
      }),
    );
    writeFileSync(join(swarmPath, 'board.jsonl'), JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder go' }) + '\n');

    // Include >12 KB filler step between models so fast rawSpan path (>8192 remBytes) is exercised
    const padding = 'x'.repeat(14_000);
    const trFile = join(logsDir, 'transcript.jsonl');
    writeFileSync(
      trFile,
      [
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          model: 'claude-opus-4-6',
          input_tokens: 100_000,
          cache_read_tokens: 400_000,
          output_tokens: 10_000,
          content: padding,
          tool_calls: [{ name: 'swarm', args: { action: 'model', model: 'spoofed-nested-model' } }],
          created_at: '2026-11-26T10:00:00Z',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-hydrogen-high',
          input_tokens: 200_000,
          cache_read_tokens: 100_000,
          output_tokens: 20_000,
          tool_calls: [],
          created_at: '2026-11-26T10:01:00Z',
        }),
      ].join('\n') + '\n',
    );

    const { summary } = summarizeTranscript(dir, workerId);
    assert.equal(summary.model, 'gemini-4-hydrogen-high');
    assert.equal(summary.modelSpec.contextLimit, 1_000_000);
    assert.equal(summary.contextLimit, 1_000_000);
    // 300k context tokens out of 1M ceiling => 30% (NOT clamped to 100% at 200k!)
    assert.equal(summary.contextPct, 30);
    assert.deepEqual(Object.keys(summary.byModel).sort(), ['claude-opus-4-6', 'gemini-4-hydrogen-high']);
    assert.equal(summary.byModel['claude-opus-4-6'].steps, 1);
    assert.equal(summary.byModel['claude-opus-4-6'].outputTokens, 10_000);
    assert.equal(summary.byModel['gemini-4-hydrogen-high'].steps, 1);
    assert.equal(summary.byModel['gemini-4-hydrogen-high'].inputTokens, 200_000);

    // Opus: 1.50 + 0.60 + 0.75 = 2.85; Gemini Pro: 0.25 + 0.03125 + 0.20 = 0.48125 => 3.33125
    assert.equal(summary.cost.pricingKnown, true);
    assert.equal(summary.cost.inputUsd, 1.75);
    assert.equal(summary.cost.cacheReadUsd, 0.63125);
    assert.equal(summary.cost.outputUsd, 0.95);
    assert.equal(summary.cost.totalUsd, 3.33125);
    // Savings: Opus 400k*(15-1.5)/1e6 = 5.40; Gemini 100k*(1.25-0.3125)/1e6 = 0.09375 => 5.49375
    assert.equal(summary.cost.cacheSavingsUsd, 5.49375);
    // Cache hit %: 500k / (300k + 500k) * 100 = 62.5%
    assert.equal(summary.cost.cacheHitPct, 62.5);

    const snap = buildSwarmSnapshot(dir, coordId);
    assert.equal(snap.contextLimit, 1_000_000);
    assert.equal(snap.contextPct, 30);
    assert.equal(snap.cost.totalUsd, 3.33125);
    assert.equal(snap.cost.cacheSavingsUsd, 5.49375);
    assert.equal(snap.cost.cacheHitPct, 62.5);
    assert.equal(snap.cost.pricingKnown, true);
    assert.deepEqual(Object.keys(snap.byModel).sort(), ['claude-opus-4-6', 'gemini-4-hydrogen-high']);

    const builder = snap.members.find((m) => m.name === 'builder');
    assert.equal(builder.contextLimit, 1_000_000);
    assert.equal(builder.contextPct, 30);
    assert.equal(builder.cost.totalUsd, 3.33125);

    // Incremental append continues accumulating on the new model without double-counting Opus
    appendFileSync(
      trFile,
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 0,
        tool_calls: [],
      }) + '\n',
    );
    const { summary: afterAppend } = summarizeTranscript(dir, workerId);
    assert.equal(afterAppend.byModel['claude-opus-4-6'].steps, 1);
    assert.equal(afterAppend.byModel['gemini-4-hydrogen-high'].steps, 2);
    assert.equal(afterAppend.byModel['gemini-4-hydrogen-high'].inputTokens, 300_000);
    assert.equal(afterAppend.cost.totalUsd, 3.45625);

    // Truncation/rotation resets and rebuilds byModel cleanly
    writeFileSync(
      trFile,
      JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        model: 'claude-sonnet-4-6',
        input_tokens: 100_000,
        cache_read_tokens: 50_000,
        output_tokens: 0,
        tool_calls: [],
      }) + '\n',
    );
    const { summary: afterTrunc } = summarizeTranscript(dir, workerId);
    assert.deepEqual(Object.keys(afterTrunc.byModel), ['claude-sonnet-4-6']);
    assert.equal(afterTrunc.contextLimit, 200_000);
    assert.equal(afterTrunc.contextPct, 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeBurnSummary ranks by costUsd over raw tokens for cache-heavy cheap vs output-heavy steps', () => {
  const cacheSpec = getModelSpec('gemini-3-flash');
  const opusSpec = getModelSpec('claude-opus-5-5-high');

  // Cache-heavy Gemini Flash: 1,000,000 cached tokens => $0.075 USD
  // Output-heavy Claude Opus: 10k input + 50k output => $0.15 + $3.75 = $3.90 USD
  const burn = computeBurnSummary(
    [
      {
        name: 'cache-reader',
        model: 'gemini-3-flash',
        roleWorker: false,
        usage: { inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
        cost: {
          totalUsd: (1_000_000 * cacheSpec.cacheReadPer1M) / 1e6,
          cacheSavingsUsd: (1_000_000 * (cacheSpec.inPer1M - cacheSpec.cacheReadPer1M)) / 1e6,
          cacheHitPct: 100,
          pricingKnown: true,
        },
      },
      {
        name: 'opus-writer',
        model: 'claude-opus-5-5-high',
        roleWorker: false,
        usage: { inputTokens: 10_000, cacheReadTokens: 0, outputTokens: 50_000, totalTokens: 60_000 },
        cost: {
          totalUsd: (10_000 * opusSpec.inPer1M + 50_000 * opusSpec.outPer1M) / 1e6,
          cacheSavingsUsd: 0,
          cacheHitPct: 0,
          pricingKnown: true,
        },
      },
    ],
    1_060_000,
  );

  assert.equal(burn.pricingKnown, true);
  assert.equal(burn.topWorker?.name, 'opus-writer');
  assert.equal(burn.topWorker?.level, 'critical');
  assert.equal(burn.topWorker?.costUsd, 3.9);
  assert.equal(burn.workers[1].name, 'cache-reader');
  assert.equal(burn.workers[1].level, 'normal');
  assert.equal(burn.workers[1].cacheHitPct, 100);
  assert.equal(burn.workers[1].cacheSavingsUsd, 0.225);
  assert.equal(burn.highBurnCount, 1);
  assert.equal(burn.costUsd, 3.975);
  assert.equal(burn.cacheSavingsUsd, 0.225);
  assert.equal(burn.cacheHitPct, 99);

  // Unknown pricing falls back to token-based ranking
  const unknownBurn = computeBurnSummary(
    [
      {
        name: 'custom-a',
        roleWorker: false,
        usage: { inputTokens: 50_000, cacheReadTokens: 0, outputTokens: 0, totalTokens: 50_000 },
        cost: { totalUsd: 0, cacheSavingsUsd: 0, cacheHitPct: 0, pricingKnown: false },
      },
      {
        name: 'custom-b',
        roleWorker: false,
        usage: { inputTokens: 200_000, cacheReadTokens: 0, outputTokens: 0, totalTokens: 200_000 },
        cost: { totalUsd: 0, cacheSavingsUsd: 0, cacheHitPct: 0, pricingKnown: false },
      },
    ],
    250_000,
  );
  assert.equal(unknownBurn.pricingKnown, false);
  assert.equal(unknownBurn.topWorker?.name, 'custom-b');
  assert.equal(unknownBurn.topWorker?.level, 'critical');
});

test('E1 hardening: buildSwarmDelta handles corrupt partial tail, same-size rewrite, and truncate+grow cleanly', () => {
  const dir = makeScratchDir('delta-h1-');
  try {
    const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swDir, { recursive: true });
    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({
        title: 'Delta Hardening',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator' },
          builder: { conversation_id: workerId, role: 'worker' },
        },
      }),
    );

    const boardPath = join(swDir, 'board.jsonl');
    const l1 = JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder start' });
    const l2 = JSON.stringify({ seq: 2, agent: 'builder', text: '@coordinator working' });
    writeFileSync(boardPath, l1 + '\n' + l2 + '\n');

    const full0 = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 0 });
    assert.equal(full0.mode, 'full');
    assert.equal(full0.head, 2);

    // 1. Corrupt partial tail line followed by newline + valid seq 3 skips corrupt line without losing seq 3
    appendFileSync(boardPath, '{"seq":99,"broken":true');
    const midCorrupt = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 2, prevEtag: full0.etag });
    assert.equal(midCorrupt.mode, 'delta');
    assert.equal(midCorrupt.head, 2);
    assert.equal(midCorrupt.messagesDelta.length, 0);

    appendFileSync(boardPath, '\n' + JSON.stringify({ seq: 3, agent: 'builder', text: '@coordinator recovered' }) + '\n');
    const afterCorrupt = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 2, prevEtag: midCorrupt.etag });
    assert.equal(afterCorrupt.mode, 'delta');
    assert.equal(afterCorrupt.head, 3);
    assert.deepEqual(afterCorrupt.messagesDelta.map((m) => m.seq), [3]);

    // 2. Truncate mid-line and rewrite to LARGER size on same inode -> tailAnchor mismatch forces mode: "full"
    const oldBuf = readFileSync(boardPath);
    const padded = JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder ' + 'P'.repeat(oldBuf.length + 64) }) + '\n';
    writeFileSync(boardPath, padded);
    const growRewrite = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 3, prevEtag: afterCorrupt.etag });
    assert.equal(growRewrite.mode, 'full');
    assert.equal(growRewrite.head, 1);
    assert.equal(growRewrite.messages.length, 1);

    // 3. Same-size overwrite with different mtime transitions cleanly to mode: "full" without skipping
    const prevLen = Buffer.byteLength(padded, 'utf8');
    const baseSame = JSON.stringify({ seq: 2, agent: 'builder', text: '@coordinator ' }) + '\n';
    const qFill = 'Q'.repeat(prevLen - Buffer.byteLength(baseSame, 'utf8'));
    const sameLenLine = JSON.stringify({ seq: 2, agent: 'builder', text: '@coordinator ' + qFill }) + '\n';
    assert.equal(Buffer.byteLength(sameLenLine, 'utf8'), prevLen);
    writeFileSync(boardPath, sameLenLine);
    const tFuture = new Date(Date.now() + 5000);
    utimesSync(boardPath, tFuture, tFuture);
    const sameSizeFull = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 1, prevEtag: growRewrite.etag });
    assert.equal(sameSizeFull.mode, 'full');
    assert.equal(sameSizeFull.head, 2);
    assert.equal(sameSizeFull.messages[0].seq, 2);

    // 4. Truncate to 0 bytes -> mode: "full" with head: 0, empty messages
    truncateSync(boardPath, 0);
    const zeroFull = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 2, prevEtag: sameSizeFull.etag });
    assert.equal(zeroFull.mode, 'full');
    assert.equal(zeroFull.head, 0);
    assert.equal(zeroFull.messages.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2 hardening: tuned secret scrubbing, UTF-8/binary slice safety, and CWE-59 intermediate symlink checks', () => {
  const dir = makeScratchDir('tr-h1-');
  try {
    const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const logsDirSymId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const memberDirSymId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const danglingSymId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const workerLogs = join(dir, 'brain', workerId, '.system_generated', 'logs');
    mkdirSync(swDir, { recursive: true });
    mkdirSync(workerLogs, { recursive: true });

    const outsideDir = join(dir, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'LEAK' }) + '\n');

    // Intermediate logs symlink escape
    const symLogsParent = join(dir, 'brain', logsDirSymId, '.system_generated');
    mkdirSync(symLogsParent, { recursive: true });
    symlinkSync(outsideDir, join(symLogsParent, 'logs'));

    // Member dir symlink escape
    symlinkSync(outsideDir, join(dir, 'brain', memberDirSymId));

    // Dangling transcript symlink
    const danglingLogs = join(dir, 'brain', danglingSymId, '.system_generated', 'logs');
    mkdirSync(danglingLogs, { recursive: true });
    symlinkSync(join(dir, 'does-not-exist.jsonl'), join(danglingLogs, 'transcript.jsonl'));

    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({
        title: 'Transcript Hardening',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator' },
          builder: { conversation_id: workerId, role: 'worker' },
          sym_logs: { conversation_id: logsDirSymId, role: 'worker' },
          sym_member: { conversation_id: memberDirSymId, role: 'worker' },
          sym_dangling: { conversation_id: danglingSymId, role: 'worker' },
        },
      }),
    );

    // 1. CWE-59 intermediate & dangling symlinks all rejected with 400
    for (const badMember of ['sym_logs', 'sym_member', 'sym_dangling']) {
      const r = readTranscriptSteps([dir], { conversationId: coordId, member: badMember });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    }

    // 2. Tuned secret scrubbing: short tokens scrubbed, normal English prose & tool names intact
    writeFileSync(
      join(workerLogs, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          content:
            'The bearer of bad news used Bearer authentication and Bearer token validation for sk-learn desk-check task-runner.',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content:
            'Secrets: Bearer ab12 Authorization: Bearer abcd sk-1234 sk-proj-ab12 ghp_1234 gho_abcd AIza1234 xoxb-1234 AKIA1234',
          tool_calls: [
            { name: 'ask_question', args: { prompt: 'Check Bearer header format' } },
            { name: 'run_command', args: { CommandLine: 'echo sk-ant-xy12' } },
          ],
        }),
      ].join('\n') + '\n',
    );
    const scrubRes = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', limit: 10 });
    assert.equal(scrubRes.ok, true);
    const s1 = scrubRes.steps[0];
    const s0 = scrubRes.steps[1];
    assert.ok(s0.content.includes('The bearer of bad news'));
    assert.ok(s0.content.includes('Bearer authentication'));
    assert.ok(s0.content.includes('Bearer token validation'));
    assert.ok(s0.content.includes('sk-learn desk-check task-runner'));
    assert.equal(s1.toolCalls[0].name, 'ask_question');
    assert.equal(s1.toolCalls[0].args.prompt, 'Check Bearer header format');
    assert.equal(s1.toolCalls[1].name, 'run_command');
    for (const secret of ['ab12', 'abcd', 'sk-1234', 'sk-proj-ab12', 'ghp_1234', 'gho_abcd', 'AIza1234', 'xoxb-1234', 'AKIA1234', 'sk-ant-xy12']) {
      assert.ok(!s1.content.includes(secret) && !JSON.stringify(s1.toolCalls).includes(secret), `Secret leaked: ${secret}`);
    }

    // 3. Multi-byte UTF-8 across 64 KiB chunk boundary + 512 KiB binary/corrupt block + truncated UTF-8 tail
    const trPath = join(workerLogs, 'transcript.jsonl');
    const chunks = [];
    // Valid early steps
    for (let i = 0; i < 5; i++) {
      chunks.push(Buffer.from(JSON.stringify({ step_index: i, type: 'USER_INPUT', content: `early-${i}` }) + '\n', 'utf8'));
    }
    // >512 KiB of raw binary/malformed lines with invalid UTF-8 bytes & NUL bytes
    const binLine = Buffer.concat([Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28]), Buffer.alloc(4096, 0x81), Buffer.from('\n')]);
    for (let i = 0; i < 140; i++) chunks.push(binLine);
    // Valid step spanning >64 KiB chunk boundary with 4-byte UTF-8 emojis 🚀 right around 65536 bytes
    const emojiPad = '🚀'.repeat(17000); // ~68 KB
    chunks.push(Buffer.from(JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', content: `utf8-ok-${emojiPad}`, tool_calls: [] }) + '\n', 'utf8'));
    // Truncated partial line with half of a 4-byte UTF-8 sequence at EOF (no trailing newline)
    chunks.push(Buffer.concat([Buffer.from('{"step_index":7,"type":"USER_INPUT","content":"torn '), Buffer.from([0xf0, 0x9f])]));
    writeFileSync(trPath, Buffer.concat(chunks));

    const binP1 = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', limit: 10 });
    assert.equal(binP1.ok, true);
    assert.deepEqual(binP1.steps.map((s) => s.stepIndex), [6]);
    assert.ok(binP1.steps[0].content.startsWith('utf8-ok-🚀'));
    // Walk pages to completion without infinite loop
    let cur = binP1.nextBefore;
    let guard = 0;
    while (cur !== null && guard < 10) {
      const next = readTranscriptSteps([dir], { conversationId: coordId, member: 'builder', before: cur, limit: 10 });
      assert.equal(next.ok, true);
      assert.ok(next.nextBefore === null || next.nextBefore < cur, 'nextBefore must strictly decrease');
      cur = next.nextBefore;
      guard++;
    }
    assert.ok(guard < 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3 hardening: clamps negative/NaN/Infinity tokens, guards division-by-zero, and resets byModel on shrink/rotate', () => {
  const dir = makeScratchDir('cost-h1-');
  try {
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const logsDir = join(dir, 'brain', workerId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const trFile = join(logsDir, 'transcript.jsonl');

    // Mix of negative, NaN string, Infinity, boolean, huge >308-digit integer, and valid padding
    const hugeDigits = '9'.repeat(320);
    const pad = 'p'.repeat(14_000);
    writeFileSync(
      trFile,
      [
        `{"step_index":0,"type":"PLANNER_RESPONSE","model":"claude-opus-4-6","input_tokens":${hugeDigits},"cache_read_tokens":-500,"output_tokens":100,"content":"${pad}","tool_calls":[]}`,
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-3-pro',
          usage: { input_tokens: -100, cache_read_tokens: 'NaN', output_tokens: null },
          tool_calls: [],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-3-pro',
          input_tokens: true,
          cache_read_tokens: 0,
          output_tokens: 0,
          tool_calls: [],
        }),
      ].join('\n') + '\n',
    );

    const { summary } = summarizeTranscript(dir, workerId);
    assert.equal(Number.isFinite(summary.usage.inputTokens), true);
    assert.equal(summary.usage.inputTokens, 0);
    assert.equal(summary.usage.cacheReadTokens, 0);
    assert.equal(summary.usage.outputTokens, 100);
    assert.equal(summary.cost.cacheHitPct, 0);
    assert.equal(summary.contextPct, 0);
    assert.equal(Number.isFinite(summary.cost.totalUsd), true);

    // Same-size overwrite with a different model resets byModel cleanly
    const stepA = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      model: 'claude-opus-4-6',
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 100,
      tool_calls: [],
    }) + '\n';
    writeFileSync(trFile, stepA);
    const sA = summarizeTranscript(dir, workerId).summary;
    assert.deepEqual(Object.keys(sA.byModel), ['claude-opus-4-6']);

    const stepB = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      model: 'gpt-4o-mini-xxx',
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 100,
      tool_calls: [],
    }) + '\n';
    assert.equal(Buffer.byteLength(stepB, 'utf8'), Buffer.byteLength(stepA, 'utf8'));
    writeFileSync(trFile, stepB);
    const fut = new Date(Date.now() + 5000);
    utimesSync(trFile, fut, fut);
    const sB = summarizeTranscript(dir, workerId).summary;
    assert.deepEqual(Object.keys(sB.byModel), ['gpt-4o-mini-xxx']);
    assert.equal(sB.contextLimit, 128_000);

    // Truncate to 0 bytes resets byModel and cost to 0 cleanly
    truncateSync(trFile, 0);
    const sZero = summarizeTranscript(dir, workerId).summary;
    assert.deepEqual(sZero.byModel, {});
    assert.equal(sZero.cost.totalUsd, 0);
    assert.equal(sZero.cost.cacheHitPct, 0);
    assert.equal(sZero.contextPct, 0);

    // computeBurnSummary guards negative/NaN/Infinity & zero denominators
    const burn = computeBurnSummary([
      {
        name: 'bad-metrics',
        roleWorker: false,
        usage: { inputTokens: -10, cacheReadTokens: NaN, outputTokens: Infinity, totalTokens: -5 },
        cost: { totalUsd: -1, cacheSavingsUsd: NaN, cacheHitPct: Infinity, pricingKnown: true },
      },
      {
        name: 'zero-tok-cost',
        roleWorker: false,
        usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { totalUsd: 0.5, cacheSavingsUsd: 0, cacheHitPct: 0, pricingKnown: true },
      },
    ], 0);
    assert.equal(burn.cacheHitPct, 0);
    assert.equal(burn.costUsd, 0.5);
    assert.equal(Number.isFinite(burn.topWorker?.sharePct), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fleet_ops.json enforces atomic 64-entry ring persistence, sanitization, corrupt recovery, and CWE-22/CWE-59 confinement', () => {
  const dir = makeScratchDir('ops-ring-');
  try {
    const coordId = '11111111-1111-4111-8111-111111111111';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swDir, { recursive: true });
    writeFileSync(
      join(swDir, 'members.json'),
      JSON.stringify({
        title: 'Ops Ring Swarm',
        members: { coordinator: { conversation_id: coordId, role: 'coordinator', wake_mode: 'mentions' } },
      }),
    );

    // Record 70 entries -> strictly retains latest 64
    for (let i = 1; i <= 70; i++) {
      const payload = JSON.parse(`{"channel":"main","text":"post-${i}","__proto__":{"polluted":true}}`);
      const res = recordOperatorOp(dir, coordId, {
        opId: `op-${i}`,
        clientOpId: `cli-${i}`,
        op: 'board_post',
        target: '#main',
        payload,
        status: 'dispatched',
        createdAt: new Date(1_700_000_000_000 + i * 100).toISOString(),
        updatedAt: new Date(1_700_000_000_000 + i * 100).toISOString(),
        coordinatorId: coordId,
        resolvedSeq: null,
        error: null,
      }, { baselineSeq: i });
      assert.equal(res.ok, true);
    }

    const readBack = readOperatorOps(dir, coordId);
    assert.equal(readBack.ok, true);
    assert.equal(readBack.ops.length, 64);
    assert.equal(readBack.ops[0].opId, 'op-7');
    assert.equal(readBack.ops[63].opId, 'op-70');
    assert.equal(Object.hasOwn(readBack.ops[63].payload, '__proto__'), false);
    assert.equal(Object.hasOwn(readBack.ops[63], '_meta'), false);
    assert.equal(({}).polluted, undefined);

    // Corrupt fleet_ops.json recovers safely to []
    const opsPath = join(swDir, 'fleet_ops.json');
    writeFileSync(opsPath, '{corrupt json');
    assert.deepEqual(readOperatorOps(dir, coordId), { ok: true, ops: [] });
    const snapCorrupt = buildSwarmSnapshot(dir, coordId);
    assert.deepEqual(snapCorrupt.ops, []);

    // CWE-22 traversal and CWE-59 symlink escape fail closed
    assert.equal(readOperatorOps(dir, '../escape').ok, false);
    const outsideFile = join(dir, 'outside-ops.json');
    writeFileSync(outsideFile, '[]');
    rmSync(opsPath, { force: true });
    symlinkSync(outsideFile, opsPath);
    const symRead = readOperatorOps(dir, coordId);
    assert.equal(symRead.ok, false);
    assert.equal(symRead.status, 403);
    const symWrite = recordOperatorOp(dir, coordId, { opId: 'op-sym', op: 'nudge', target: coordId });
    assert.equal(symWrite.ok, false);
    assert.equal(symWrite.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileOperatorOps verifies via board/members/plan, handles ERROR_MESSAGE & 45000ms timeout, and updates snapshots & deltas', () => {
  const dir = makeScratchDir('ops-reconcile-');
  try {
    const coordId = '11111111-1111-4111-8111-111111111111';
    const workerId = '22222222-2222-4222-8222-222222222222';
    const swDir = join(dir, 'brain', coordId, '.system_generated', 'swarm');
    const coordLogs = join(dir, 'brain', coordId, '.system_generated', 'logs');
    mkdirSync(swDir, { recursive: true });
    mkdirSync(coordLogs, { recursive: true });

    const membersPath = join(swDir, 'members.json');
    const boardPath = join(swDir, 'board.jsonl');
    const planPath = join(swDir, 'plan.json');
    const coordTrPath = join(coordLogs, 'transcript.jsonl');

    const t0 = Date.now();
    const t0Iso = new Date(t0).toISOString();

    writeFileSync(
      membersPath,
      JSON.stringify({
        title: 'Reconcile Swarm',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', wake_mode: 'mentions' },
          worker: { conversation_id: workerId, role: 'worker', model: 'gemini-2.5-flash', wake_mode: 'mentions' },
          builder: { conversation_id: '44444444-4444-4444-8444-444444444444', role: 'worker', model: 'gemini-2.5-flash', wake_mode: 'mentions' },
        },
      }),
    );
    writeFileSync(boardPath, JSON.stringify({ seq: 1, agent: 'coordinator', text: 'Init' }) + '\n');
    writeFileSync(planPath, JSON.stringify({ title: 'Seed', milestones: [{ title: 'Gate', status: 'in_progress' }] }));
    // Pre-existing ERROR_MESSAGE before t0 must NOT fail ops dispatched at t0
    writeFileSync(
      coordTrPath,
      JSON.stringify({
        step_index: 0,
        type: 'ERROR_MESSAGE',
        created_at: new Date(t0 - 10_000).toISOString(),
        error: 'Stale error before dispatch',
      }) + '\n',
    );

    const opsSeed = [
      { opId: 'op-spawn', op: 'spawn_worker', target: 'qa-bot', payload: { name: 'qa-bot' } },
      { opId: 'op-model', op: 'switch_model', target: 'builder', payload: { member: 'builder', model: 'gemini-3-pro' } },
      { opId: 'op-kill', op: 'kill_worker', target: 'worker', payload: { member: 'worker' } },
      { opId: 'op-post', op: 'board_post', target: '#backend', payload: { channel: 'backend', text: 'Run smoke tests' } },
      { opId: 'op-chan', op: 'channel_op', target: '#ops', payload: { action: 'create', channel: 'ops' } },
      { opId: 'op-gate-plan', op: 'gate_verdict', target: '#1', payload: { verdict: 'verified', seq: 1, note: 'ok' } },
      { opId: 'op-tag', op: 'nudge', target: workerId, payload: { conversationIds: [workerId], message: 'Ping' } },
      { opId: 'op-stale', op: 'board_post', target: '#main', payload: { channel: 'main', text: 'Never answered' } },
    ];
    const initialCtx = getSwarmOpContext(dir, coordId);
    for (const o of opsSeed) {
      recordOperatorOp(
        dir,
        coordId,
        {
          ...o,
          clientOpId: null,
          status: 'dispatched',
          createdAt: t0Iso,
          updatedAt: t0Iso,
          coordinatorId: coordId,
          resolvedSeq: null,
          error: null,
        },
        {
          baselineSeq: initialCtx.baselineSeq,
          baselinePlanKey: initialCtx.baselinePlanKey,
          dispatchedAt: t0Iso,
          existedAtDispatch: o.op === 'kill_worker',
        },
      );
    }

    // Before any evidence and before 45s -> all remain dispatched
    const r0 = reconcileOperatorOps(dir, coordId, { now: t0 + 10_000 });
    assert.equal(r0.ops.every((o) => o.status === 'dispatched'), true);

    // Apply evidence on members.json, board.jsonl, and plan.json
    writeFileSync(
      membersPath,
      JSON.stringify({
        title: 'Reconcile Swarm',
        members: {
          coordinator: { conversation_id: coordId, role: 'coordinator', wake_mode: 'mentions' },
          worker: { conversation_id: workerId, role: 'worker', model: 'gemini-2.5-flash', killed: true },
          builder: { conversation_id: '44444444-4444-4444-8444-444444444444', role: 'worker', model: 'gemini-3-pro', wake_mode: 'mentions' },
          'qa-bot': { conversation_id: '33333333-3333-4333-8333-333333333333', role: 'worker' },
        },
      }),
    );
    appendFileSync(
      boardPath,
      [
        JSON.stringify({ seq: 2, agent: 'coordinator', channel: 'backend', text: 'Run smoke tests right now' }),
        JSON.stringify({ seq: 3, agent: 'coordinator', text: 'Channel created', control: { op: 'create', channel: 'ops' } }),
        JSON.stringify({ seq: 4, agent: 'worker', text: 'Acknowledged [opId=op-tag]' }),
      ].join('\n') + '\n',
    );
    writeFileSync(planPath, JSON.stringify({ title: 'Seed', milestones: [{ title: 'Gate', status: 'done' }] }));

    const snapBeforeTimeout = buildSwarmSnapshot(dir, coordId);
    const byId1 = Object.fromEntries(snapBeforeTimeout.ops.map((o) => [o.opId, o]));
    assert.equal(byId1['op-spawn'].status, 'verified');
    assert.equal(byId1['op-model'].status, 'verified');
    assert.equal(byId1['op-kill'].status, 'verified');
    assert.equal(byId1['op-post'].status, 'verified');
    assert.equal(byId1['op-post'].resolvedSeq, 2);
    assert.equal(byId1['op-chan'].status, 'verified');
    assert.equal(byId1['op-chan'].resolvedSeq, 3);
    assert.equal(byId1['op-gate-plan'].status, 'verified');
    assert.equal(byId1['op-tag'].status, 'verified');
    assert.equal(byId1['op-tag'].resolvedSeq, 4);
    assert.equal(byId1['op-stale'].status, 'dispatched');

    // Past 45000ms -> op-stale transitions to timed_out
    const rTimeout = reconcileOperatorOps(dir, coordId, { now: t0 + OPS_TIMEOUT_MS + 100 });
    const staleAfter = rTimeout.ops.find((o) => o.opId === 'op-stale');
    assert.equal(staleAfter.status, 'timed_out');

    // New op fails when coordinator transcript emits ERROR_MESSAGE after createdAt, reflected in buildSwarmDelta
    const deltaInit = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 4 });
    const t1 = Date.now();
    const t1Iso = new Date(t1).toISOString();
    recordOperatorOp(
      dir,
      coordId,
      {
        opId: 'op-err',
        clientOpId: null,
        op: 'board_post',
        target: '#main',
        payload: { channel: 'main', text: 'Will fail' },
        status: 'dispatched',
        createdAt: t1Iso,
        updatedAt: t1Iso,
        coordinatorId: coordId,
        resolvedSeq: null,
        error: null,
      },
      { baselineSeq: 4, dispatchedAt: t1Iso },
    );
    appendFileSync(
      coordTrPath,
      JSON.stringify({
        step_index: 1,
        type: 'ERROR_MESSAGE',
        created_at: new Date(t1 + 5).toISOString(),
        error: 'Rate limit Bearer sk-secret123456',
      }) + '\n',
    );
    const deltaAfterErr = buildSwarmDelta({
      appData: dir,
      conversationId: coordId,
      since: 4,
      prevEtag: deltaInit.etag,
    });
    assert.equal(deltaAfterErr.mode, 'delta');
    assert.notEqual(deltaAfterErr.etag, deltaInit.etag);
    const failedOp = deltaAfterErr.ops.find((o) => o.opId === 'op-err');
    assert.equal(failedOp.status, 'failed');
    assert.ok(failedOp.error.includes('Rate limit'));
    assert.ok(!failedOp.error.includes('sk-secret123456'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
