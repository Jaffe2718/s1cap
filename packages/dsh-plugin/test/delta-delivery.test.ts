import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { deliverContext, visibleMessagesOf } from '../src/context-delivery.ts';
import type { ContextDeliveryInput } from '../src/context-delivery.ts';
import { preStepMiddleware } from '../src/index.ts';
import { MessageId } from '@deepseek-ai/dsh-llm/brand';
import type { UserMessage } from '@deepseek-ai/dsh-llm/message';
import type { StepObserver } from '../src/step-observer.ts';

const a = { id: 'a', kind: 'toolResult', text: 'port=5432; database=inventory' };
const b = { id: 'b', kind: 'user', text: 'Keep the public API compatible.' };
const trace = '<trace_start>Inspect schema before editing.<trace_end>';
const input = (overrides: Partial<ContextDeliveryInput> = {}): ContextDeliveryInput => ({
  enabled: true, trigger: 'every-step', step: 2, order: ['stateProxy', 'recalled', 'anchor'],
  stateProxy: trace, recalled: [a, b], anchor: { id: 'q', kind: 'user', text: 'fix' },
  messages: [], visibleMessages: [], ...overrides,
});
const text = (result: ReturnType<typeof deliverContext>): string =>
  (result.messages?.at(-1) as { content?: { text: string }[] })?.content?.[0]?.text ?? '';

test('recall budget defers whole blocks and duplicate text under different ids is sent once',()=>{
 const result=deliverContext(input({stateProxy:'',recalled:[a,{...a,id:'copy'},b],recallMaxSegments:1}));
 assert.ok(text(result).includes(a.text));assert.ok(!text(result).includes(b.text));
 assert.equal(result.recallDelivery?.duplicates,1);assert.equal(result.recallDelivery?.deferred,1);
 const next=deliverContext(input({stateProxy:'',visibleMessages:result.messages!,recallMaxSegments:1}));
 assert.ok(text(next).includes(b.text));assert.ok(!text(next).includes(a.text));
 const tiny=deliverContext(input({stateProxy:'',recalled:[a],recallMaxTokens:1}));
 assert.equal(tiny.delivered,false);assert.equal(tiny.recallDelivery?.deferred,1);
 assert.equal(tiny.recallDelivery?.tokens,0);
});

test('compacted content under another id is not recalled again; altered content stays eligible',()=>{
 const visible=[{id:'summary',role:'user',content:[{type:'text',text:a.text}]}];
 assert.equal(deliverContext(input({stateProxy:'',recalled:[a],visibleMessages:visible})).delivered,false);
 assert.equal(deliverContext(input({stateProxy:'',recalled:[{...a,text:'port=6432'}],visibleMessages:visible})).delivered,true);
});

test('a changing selection sends only the delta, with the same facts still visible', () => {
  const first = deliverContext(input({ recalled: [a] }));
  const second = deliverContext(input({ visibleMessages: first.messages! }));
  assert.deepEqual(second.blocks, ['recalled']);
  assert.ok(text(second).includes(b.text));
  assert.ok(!text(second).includes(a.text));
  assert.ok(!text(second).includes(trace));
  const visible = [...first.messages!, ...second.messages!];
  assert.equal(deliverContext(input({ visibleMessages: visible })).delivered, false);
  // A different session has a different projection, even when all ids match.
  assert.deepEqual(deliverContext(input()).blocks, ['stateProxy', 'recalled', 'recalled']);
});

test('verbatim original messages and chunks are not reinserted, but changed text is', () => {
  const original = { id: 'a', content: [{ type: 'text', text: a.text }] };
  const result = deliverContext(input({ stateProxy: '', recalled: [a], visibleMessages: [original] }));
  assert.equal(result.delivered, false);
  assert.equal(deliverContext(input({ stateProxy: '', recalled: [{ ...a, id: 'a#0', chunkOf: 'a' }],
    visibleMessages: [original] })).delivered, false);
  assert.equal(deliverContext(input({ stateProxy: '', recalled: [{ ...a, text: 'port=6432' }],
    visibleMessages: [original] })).delivered, true);
});

test('a partial injection pruned by compaction is eligible again; retained blocks stay suppressed', () => {
  const first = deliverContext(input({ recalled: [a] }));
  const second = deliverContext(input({ visibleMessages: first.messages! }));
  const afterCompaction = deliverContext(input({ visibleMessages: second.messages! }));
  assert.deepEqual(afterCompaction.blocks, ['stateProxy', 'recalled']);
  assert.ok(text(afterCompaction).includes(a.text));
  assert.ok(!text(afterCompaction).includes(b.text));
});

test('visibility failures are conservative and the session method keeps its receiver', () => {
  assert.equal(visibleMessagesOf({}), undefined);
  assert.equal(visibleMessagesOf({ agent: { session: { deriveMessages() { throw Error('unavailable'); } } } }), undefined);
  const session = { messages: [{ id: 'a' }], deriveMessages() { return this.messages; } };
  assert.deepEqual(visibleMessagesOf({ agent: { session } }), session.messages);
});

test('real DSH surface compaction and middleware permit re-delivery after replacement', async () => {
  const session = Session.create('delta-test' as SessionId);
  const payload = { agent: { session }, messages: [], step: 2 };
  const observer = {
    observe: async () => ({ layout: { order: ['stateProxy', 'recalled', 'anchor'] } }),
    stats: () => ({ ingestOnly: 0 }),
  } as unknown as StepObserver;
  const middleware = preStepMiddleware({ on() {} }, { observer, cell: 'C2', assemblyTrigger: 'every-step',
    emit: () => {}, deliver: (_built, _decision, _payload, visibleMessages) =>
      deliverContext(input({ visibleMessages })) });
  const next = async () => ({ kind: 'enter', messages: [] });
  const first = await middleware(payload, next) as { messages: UserMessage[] };
  assert.equal(first.messages.length, 1);
  const event = session.append('user/message', first.messages[0]!, { surfaceOp: 'append' });
  assert.equal((await middleware(payload, next) as { messages: unknown[] }).messages.length, 0);
  session.append('user/message', { id: MessageId('summary'), role: 'user', source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'text', text: 'Work in progress.' }] },
    { surfaceOp: { op: 'replace', start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] });
  assert.equal(visibleMessagesOf(payload)?.length, 1);
  assert.equal((await middleware(payload, next) as { messages: unknown[] }).messages.length, 1,
    'a lifetime digest must not suppress content that compaction removed');
});
