import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptMessages, estimateTokens, segmentEvent, validatePolicy } from '../src/index.ts';

function split(text: string, c = 512, omega = 64) {
  const event = adaptMessages([{ id: 'thought', role: 'assistant', content: [{ type: 'reasoning', text }] }],
    { sessionId: 'segmentation-test', startSeq: 1, now: 0 }).events[0]!;
  return segmentEvent(event, { chunkTokens: c, overlapTokens: omega });
}

test('hard splitting interprets c and omega as estimated tokens, not ASCII characters', () => {
  const chunks = split('x'.repeat(4096));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.tokens, 512);
  assert.equal(chunks[1]!.tokens, 512);
  assert.equal(chunks[2]!.tokens, 128);
});

test('thoughts keep short natural paragraphs whole and split oversized prose at sentences', () => {
  const paragraphs = ['First hypothesis. '.repeat(8).trim(), 'Counterexample invalidates the hypothesis. '.repeat(5).trim(),
    'Therefore preserve phase separation. '.repeat(5).trim()];
  const chunks = split(paragraphs.join('\n\n'), 64, 0);
  for (const paragraph of paragraphs) assert.ok(chunks.some(c => c.text.includes(paragraph)), paragraph);
  const sentences = Array.from({ length: 50 }, (_, i) => `Sentence ${i} describes a distinct observation.`);
  const long = split(sentences.join(' '), 64, 8);
  for (const sentence of sentences) assert.ok(long.some(c => c.text.includes(sentence)), sentence);
  assert.ok(long.every(c => estimateTokens(c.text) <= 64));
});

test('CJK fallback honors the same token budget without losing characters', () => {
  const chunks = split('证据'.repeat(400), 128, 0);
  assert.ok(chunks.every(c => c.tokens <= 128));
  assert.equal(chunks.map(c => c.text).join(''), '证据'.repeat(400));
});

test('profile validates segmentation geometry and the configurable short-context threshold', () => {
  const valid = validatePolicy({ segmentation: { chunkTokens: 1024, overlapTokens: 128 }, contextSelection: { shortContextTokens: 16384 } });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.policy.segmentation, { chunkTokens: 1024, overlapTokens: 128 });
  assert.equal(valid.policy.contextSelection.shortContextTokens, 16384);
  const invalid = validatePolicy({ segmentation: { chunkTokens: 128, overlapTokens: 128 } });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.policy.segmentation, { chunkTokens: 512, overlapTokens: 64 });
});
