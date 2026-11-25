import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelMentions,
  channelRegistry,
  effectiveChannels,
  memberView,
  mentions,
  mentionsOf,
  visibleUnread,
} from '../channels.mjs';

test('mentionsOf matches exact, numbered prefix, and @all', () => {
  const names = ['coordinator', 'builder-1', 'builder-2', 'verifier'];
  const r1 = mentionsOf('@builder Check the diff and report to @verifier', names);
  assert.deepEqual(r1.mentions, ['builder-1', 'builder-2', 'verifier']);
  assert.equal(r1.all, false);

  const r2 = mentionsOf('@all Stop editing now', names);
  assert.equal(r2.all, true);
  assert.equal(mentions('Ping @builder-2 when done', 'builder-2'), true);
  assert.equal(mentions('Ping email foo@builder-2.org', 'builder-2'), false);
  assert.equal(mentions('No mention foo@builder-2bar', 'builder-2'), false);
});

test('channel registry, @#channel mentions, and visibleUnread respect role defaults', () => {
  const msgs = [
    { seq: 1, agent: 'coordinator', text: 'Create #backend', control: { op: 'create', channel: 'backend', topic: 'API' } },
    { seq: 2, agent: 'coordinator', text: 'Join #backend', control: { op: 'subscribe', channel: 'backend', members: ['api-dev'], prev: {}, next: { 'api-dev': ['backend'] } } },
    { seq: 3, agent: 'api-dev', channel: 'backend', text: 'Schema ready' },
    { seq: 4, agent: 'ui-dev', text: 'Main channel update @#backend check endpoint' },
  ];

  const reg = channelRegistry(msgs);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].name, 'backend');
  assert.deepEqual(channelMentions(msgs[3].text), ['backend']);

  // ui-dev is only in main -> cannot see #backend post seq 3, sees seq 4 (own post)
  const uiView = memberView('ui-dev', 'worker', null, msgs, reg);
  assert.deepEqual(uiView.visible, [true, true, false, true]);
  assert.equal(visibleUnread('ui-dev', 'worker', null, msgs, 0, reg), 1);

  // coordinator sees '*'
  assert.deepEqual(effectiveChannels('coordinator', null, 'coordinator'), ['*']);
  assert.equal(visibleUnread('coordinator', 'coordinator', null, msgs, 0, reg), 2);
});
