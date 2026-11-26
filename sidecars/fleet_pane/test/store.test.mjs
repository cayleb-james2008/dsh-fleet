import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  buildSwarmDelta,
  buildSwarmSnapshot,
  computeBurnSummary,
  computeGateReadiness,
  findCoordinatorConvId,
  getBoardTailStats,
  listSwarms,
  normalizePlan,
  readTranscriptActivityTail,
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

    // 6. Truncation -> mode: "full" fallback
    writeFileSync(
      boardPath,
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@builder Fresh truncated board', time: '2026-11-26 10:05:00' }) + '\n',
    );
    const truncFull = buildSwarmDelta({ appData: dir, conversationId: coordId, since: 3, prevEtag: delta3.etag });
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
