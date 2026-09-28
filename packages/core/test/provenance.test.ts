import test from 'node:test';
import assert from 'node:assert/strict';

import { segmentEvent } from '../src/segmenter.ts';
import type { RawEvent } from '../src/segmenter.ts';
import {
  CONTROL_PLANE_EVENT_TYPES,
  ControlPlaneLeakError,
  ControlPlaneLog,
  SESSION_SEGMENT_KINDS,
  assertSessionEvent,
  assertSessionSegments,
  isControlPlaneEvent,
  isSessionSegment,
} from '../src/provenance.ts';
import { TELEMETRY_SCHEMA_VERSION } from '../src/telemetry.ts';
import type { S1CallEvent, TelemetryEvent } from '../src/telemetry.ts';

const SESSION = 'sess';
const schema = TELEMETRY_SCHEMA_VERSION;

function sessionEvent(seq: number, kind: RawEvent['kind'] = 'user'): RawEvent {
  return { id: `e${seq}`, sessionId: SESSION, seq, kind, text: `text of e${seq}`, ts: 1000 + seq };
}

const s1Call: S1CallEvent = {
  type: 's1_call',
  schema,
  ts: 1,
  provider: 'laya-serve',
  role: 'assoc',
  kind: 'noul',
  questions: 12,
  inputTokens: 900,
  outputTokens: 0,
  ms: 42,
  turnId: 't7',
  scoredSegmentIds: ['e1', 'e2'],
  routedModel: 'english',
};

test('the segmenter refuses control-plane records, so S1 can never score its own log', () => {
  assert.throws(() => segmentEvent(s1Call as unknown as RawEvent), ControlPlaneLeakError);
  for (const type of CONTROL_PLANE_EVENT_TYPES) {
    const record = { type, schema, ts: 0 } as unknown as RawEvent;
    assert.throws(() => segmentEvent(record), ControlPlaneLeakError, `type=${type} must be rejected`);
  }
  const segments = segmentEvent(sessionEvent(1));
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, 'user');
});

test('unknown event kinds are rejected rather than silently segmented', () => {
  const bogus = { ...sessionEvent(2), kind: 's1_log' } as unknown as RawEvent;
  assert.throws(() => segmentEvent(bogus), ControlPlaneLeakError);
  assert.throws(() => assertSessionEvent(undefined), ControlPlaneLeakError);
  assert.throws(() => assertSessionEvent({ kind: 42 }), ControlPlaneLeakError);
});

test('the two type families stay disjoint: telemetry carries `type`, segments carry `kind`', () => {
  assert.equal(isControlPlaneEvent(s1Call), true);
  assert.equal(isSessionSegment(s1Call), false);

  const segment = segmentEvent(sessionEvent(3))[0];
  assert.equal(isControlPlaneEvent(segment), false);
  assert.equal(isSessionSegment(segment), true);

  assert.equal(isControlPlaneEvent({ kind: 'user' }), false);
  assert.equal(isSessionSegment({ type: 's1_call', kind: 'user' }), false, 'a telemetry tag disqualifies it');
});

test('System-1 state and the model view may only be built from session segments', () => {
  const segments = segmentEvent(sessionEvent(4));
  assert.doesNotThrow(() => assertSessionSegments(segments));
  assert.throws(() => assertSessionSegments([...segments, s1Call]), ControlPlaneLeakError);
  assert.throws(() => assertSessionSegments([{ type: 'assembly', schema, ts: 0 }]), ControlPlaneLeakError);
  assert.throws(() => assertSessionSegments([undefined]), ControlPlaneLeakError);
});

test('the control-plane log is a separate sink and rejects session segments', () => {
  const lines: string[] = [];
  const log = new ControlPlaneLog((line) => lines.push(line));
  log.emit(s1Call);
  log.emit({ type: 'assembly', schema, ts: 2 } as TelemetryEvent);

  assert.equal(log.written, 2);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0] ?? '{}').type, 's1_call');
  assert.equal(JSON.parse(lines[0] ?? '{}').scoredSegmentIds.length, 2);
  assert.equal(JSON.parse(lines[1] ?? '{}').type, 'assembly');

  const segment = segmentEvent(sessionEvent(5))[0];
  assert.throws(() => log.emit(segment as unknown as TelemetryEvent), ControlPlaneLeakError);
  assert.equal(log.written, 2, 'the rejected write did not reach the sink');
});

test('the session kind allowlist is explicit and closed', () => {
  assert.deepEqual([...SESSION_SEGMENT_KINDS], [
    'user',
    'assistant',
    'trace',
    'toolCall',
    'toolResult',
    'systemPinned',
  ]);
});
