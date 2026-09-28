/**
 * Control-plane isolation.
 *
 * System-1 calls, their telemetry and the backend's server logs live in a log stream
 * that is **independent of the session event log**. The reason is a feedback hazard:
 * segments are what relevance scoring runs on, so if an S1 call record ever became a
 * segment, the next turn would score it, call System-1 again, and System-1 would end up
 * processing its own output — an amplifying loop whose cost grows with the number of
 * S1 calls already made.
 *
 * The boundary is enforced, not documented:
 *   I1  telemetry records are a different type family from session events
 *       (`TelemetryEvent.type` vs `RawEvent.kind`), so the compiler rejects the mix-up;
 *   I2  `segmentEvent` refuses control-plane shapes at runtime (`ControlPlaneLeakError`);
 *   I3  System-1 state is built through `assertSessionSegments`, which rejects anything
 *       that is not a session segment;
 *   I4  the control-plane log is append-only and is never read back into the model view.
 */
                                                       
import { JsonlSink } from './telemetry.js';
                                                     

/** Kinds a harness session event may carry. Everything outside this list is control-plane. */
export const SESSION_SEGMENT_KINDS                         = [
  'user',
  'assistant',
  'trace',
  'toolCall',
  'toolResult',
  'systemPinned',
];

/** Event types that belong to the control plane (telemetry), never to the session log. */
export const CONTROL_PLANE_EVENT_TYPES = [
  'llm_call',
  's1_call',
  'tool_call',
  'assembly',
  'plan_gate',
]         ;

                                                                               

export class ControlPlaneLeakError extends Error {
  constructor(message        ) {
    super(message);
    this.name = 'ControlPlaneLeakError';
  }
}

export function isControlPlaneEvent(value         )                          {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value                      ).type;
  return typeof type === 'string' && (CONTROL_PLANE_EVENT_TYPES                     ).includes(type);
}

export function isSessionSegment(value         )                   {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value                                      ;
  if (typeof candidate.type === 'string') return false; // telemetry shape
  return typeof candidate.kind === 'string' && (SESSION_SEGMENT_KINDS                     ).includes(candidate.kind);
}

/**
 * Runtime gate for the segmenter input. Throws instead of silently segmenting
 * control-plane material.
 */
export function assertSessionEvent(value         )       {
  if (isControlPlaneEvent(value)) {
    throw new ControlPlaneLeakError(
      `control-plane record (${String((value                     ).type)}) cannot enter the session log: ` +
        'segmenting it would make System-1 score its own output',
    );
  }
  const kind = typeof value === 'object' && value !== null ? (value                      ).kind : undefined;
  if (typeof kind !== 'string' || !(SESSION_SEGMENT_KINDS                     ).includes(kind)) {
    throw new ControlPlaneLeakError(`unknown session event kind: ${String(kind)}`);
  }
}

/**
 * Gate for everything that is about to be shown to, or scored by, System-1:
 * the assembled context and any `/v1/systemone` state.
 */
export function assertSessionSegments(values                    )       {
  for (const value of values) {
    if (!isSessionSegment(value)) {
      throw new ControlPlaneLeakError(
        'only session segments may enter the model view or a System-1 state',
      );
    }
  }
}

/**
 * The control-plane log: a second JSONL sink with its own file, written by the plugin
 * and read only by humans and analysis scripts. Records here carry call timing, counts,
 * routing and results, plus correlation ids (`taskId`, `turnId`, `scoredSegmentIds`) —
 * metadata only, so cost can be joined to turns without moving content around.
 */
export class ControlPlaneLog {
  #sink           ;
  #written = 0;

  constructor(write                        ) {
    this.#sink = new JsonlSink(write);
  }

  get written()         {
    return this.#written;
  }

  /** Append one control-plane record. Session segments are rejected (I4, reverse direction). */
  emit(event                )       {
    if (isSessionSegment(event)) {
      throw new ControlPlaneLeakError('session segments must not be written to the control-plane log');
    }
    this.#sink.emit(event);
    this.#written += 1;
  }
}
