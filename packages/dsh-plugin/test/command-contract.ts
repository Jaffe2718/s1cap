/**
 * The host's `CommandResult` contract, in one place, for every test that calls a command.
 *
 * Read from `@deepseek-ai/dsh-commands` (`normalizeResult`): the registry accepts exactly
 * `{kind:'success', text?: string, sourceEventSeq?: number}` or `{kind:'error', text: non-empty string}` and
 * throws `command "<name>" handler must return a CommandResult` for anything else.
 *
 * This exists because the tests used to read the raw object a handler returned, so all four `/s1*` commands were
 * broken in the shipped build while every test passed - the assertion and the contract were about different
 * things. Routing every call through here means a handler that returns a bare object fails in the suite.
 */
import assert from 'node:assert/strict';

/** Validate one handler result against the host's rules and return its text, JSON-decoded when it parses. */
export function commandPayload(value: unknown): unknown {
  assert.equal(typeof value, 'object', 'a command must return an object');
  assert.ok(value !== null, 'a command must not return null');
  const result = value as { kind?: unknown; text?: unknown };
  assert.ok('kind' in result, 'a command result must carry a kind');
  if (result.kind === 'error') {
    assert.equal(typeof result.text, 'string', 'an error result must carry text');
    assert.ok((result.text as string).trim() !== '', 'an error text must not be empty');
    return undefined;
  }
  assert.equal(result.kind, 'success', `unknown result kind ${String(result.kind)}`);
  if (result.text !== undefined) assert.equal(typeof result.text, 'string', 'success text must be a string');
  if (typeof result.text !== 'string') return undefined;
  try {
    return JSON.parse(result.text);
  } catch {
    return result.text;
  }
}

/** The raw kind, for the tests that assert a command reported a failure. */
export function commandKind(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null ? (value as { kind?: string }).kind : undefined;
}

/** The raw text, for the tests that assert on a human-readable message. */
export function commandText(value: unknown): string {
  return typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string'
    ? ((value as { text: string }).text)
    : '';
}
