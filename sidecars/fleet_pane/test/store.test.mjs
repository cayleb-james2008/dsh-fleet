import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePorcelainWorktrees, probeWorktrees } from '../git_probe.mjs';
import { buildSwarmSnapshot, listSwarms, summarizeTranscript } from '../swarm_store.mjs';

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
      writeFileSync(join(wtDir, 'dirty.txt'), 'change');

      const res = await probeWorktrees([repoDir, 'file:///etc/../etc/passwd', '../relative'], { ttlMs: 0 });
      assert.equal(res.rejected.length, 2);
      assert.equal(res.worktrees.length, 2);
      const feat = res.worktrees.find((w) => w.branch === 'feat/test');
      assert.ok(feat);
      assert.equal(feat.clean, false);
      assert.equal(feat.untrackedFiles, 1);
      assert.equal(feat.lastCommitSubject, 'Initial commit');
    } finally {
      execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', wtDir], { stdio: 'ignore' });
      rmSync(wtDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
