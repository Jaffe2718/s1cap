/**
 * A stub System-1 backend, for verifying the live S1 path without downloading a checkpoint.
 *
 * It answers `/v1/systemone` in the shape the client expects, and it deliberately returns **structured,
 * content-derived** answers rather than constants: a stub that says "0.9 to everything" would make every pair
 * clear the threshold and would prove nothing about whether the weights are being read, aligned with their
 * candidates, or gated. So relevance is computed from token overlap between the candidate it is asked about and
 * the current segment, which makes the numbers vary the way real ones would, and a `choice` answer is ordered by
 * the same overlap so the plan gate has something non-uniform to reorder.
 *
 * It also normalizes nothing, on purpose: Jev does not guarantee a sum of one, and the client's normalization is
 * part of what this verifies.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8123);
/** Traffic counters, reported by /health: proof that the live plugin really called this backend. */
let decideCalls = 0;
let questionsAsked = 0;
const byType = { score: 0, noul: 0, choice: 0 };

/** Cheap lexical overlap, so the stub's answers depend on what it was actually asked. */
function overlap(a, b) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? []);
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.max(wa.size, wb.size);
}

function lastUserToken(state) {
  return typeof state === 'object' && state !== null ? String(state.text ?? '') : String(state ?? '');
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    // The counter is the point of this endpoint: whether the live plugin called the backend at all is the one
    // question a control-plane record cannot answer, because a scored pair and a lexically scored pair look
    // identical in the log.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, decideCalls: decideCalls, questions: questionsAsked, byType: { ...byType } }));
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const state = lastUserToken(parsed.state);
    const questions = parsed.questions ?? {};
    decideCalls += 1;
    const answers = {};
    let inputTokens = 0;
    for (const [id, q] of Object.entries(questions)) {
      const criteria = q.criteria ?? [];
      questionsAsked += 1;
      if (q.type === 'score' || q.type === 'noul' || q.type === 'choice') byType[q.type] += 1;
      if (q.type === 'score') {
        // `score` is a graded list; the instructions carry the candidate text, the state carries the task.
        const value = overlap(q.instructions, state);
        answers[id] = { type: 'score', score: Math.min(0.99, 0.2 + value), confidence: 0.7 };
        inputTokens += Math.ceil(String(q.instructions).length / 4);
      } else if (q.type === 'noul') {
        const value = overlap(q.instructions, state);
        answers[id] = { type: 'noul', noul: Math.min(0.99, 0.15 + value) };
        inputTokens += Math.ceil(String(q.instructions).length / 4);
      } else if (q.type === 'choice') {
        // Deliberately not normalized: the client must normalize before it can be used, and a stub that summed
        // to one would hide a client that forgot to.
        const probs = {};
        for (const [optId, description] of Object.entries(criteria)) {
          probs[optId] = 0.5 + overlap(String(description), state) * 3;
        }
        answers[id] = { type: 'choice', choice: Object.keys(probs)[0] ?? '', probabilities: probs, confidence: 0.9 };
        inputTokens += 40;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 's1cap-stub',
        answers,
        usage: { input_tokens: inputTokens, output_tokens: Object.keys(answers).length * 2 },
        ms: 1,
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`stub s1 backend listening on http://127.0.0.1:${port}`);
});
