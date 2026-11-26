import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePorcelainWorktrees, probeWorktreeDiff, probeWorktrees } from '../git_probe.mjs';
import {
  buildSwarmSnapshot,
  computeBurnSummary,
  computeGateReadiness,
  listSwarms,
  readTranscriptActivityTail,
  summarizeTranscript,
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
