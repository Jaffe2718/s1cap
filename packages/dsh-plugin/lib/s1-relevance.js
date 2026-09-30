/**
 * S1 RELEVANCE — one System-1 call per new segment, scoring the whole window.
 *
 * This is the figure's "noul relevance" box: for a new segment s_j, decide how much reference value each
 * historical segment h_i carries for it, as a value in [0,1]. The question type is `noul` - a binary
 * "would retrieving this help?" whose P(true) is read straight as the weight - because that is what the
 * route diagram specifies (`relevance scoring (noul)`, `S1 Assoc Backend: noul relevance`). An earlier
 * implementation asked a graded 4-level `score` question and took the top level's probability mass; both
 * give a number in [0,1], but only the noul form is the thing under study, and the paper cannot describe a
 * box whose implementation asks a different question. The direction matters and is not symmetric - the
 * question is about h_i's usefulness *for s_j*, not about how similar the two strings are.
 *
 * Why one call and not one per pair: `recall.window = w` exists to bound this cost, and a per-pair scorer would
 * make the cost w calls per new segment instead of 1. The client takes any number of questions in a single
 * request, so the window is asked about in one round trip and the saving is real rather than rhetorical.
 * `scoredPairs` in the control plane still counts pairs - the graph is where that is decided, not here.
 *
 * Failure policy: a System-1 call that times out, errors, or returns an answer we cannot read yields **no
 * weights**, and the graph's caller falls back to its lexical scorer. That is deliberate. A relevance backend
 * that is briefly unavailable must cost accuracy, never the round, and never a stack trace into the harness.
 */
import { noul, normalize } from '@s1cap/s1-client';
                                                   
                                           

const MAX_SEGMENT_CHARS = 1200;

                                     
                                                                                       
                                                                                                                            
                                                            
                
     
                                                               
                            
                                 
                           
                 
 

                                   
                
                    
                      
                       
                 
                                                               
                   
 

                              
     
                                                                                                            
                                                                             
     
                                                                                             
                            
 

/** A segment rendered for the backend: bounded, and labelled so the model can judge the pair it is shown. */
function render(segment         )         {
  const text = segment.text.length > MAX_SEGMENT_CHARS
    ? `${segment.text.slice(0, MAX_SEGMENT_CHARS)}...`
    : segment.text;
  return `[${segment.kind}] ${text}`;
}

function readWeight(answer                                                                        )                     {
  if (answer === undefined) return undefined;
  // The noul answer *is* the weight: P("retrieving this would help") reduced to one number in [0,1]. A backend
  // that answers with a raw distribution over the criteria gets the same treatment - the true-side mass -
  // because the edge weight the graph consumes is a probability either way.
  if (typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return Math.max(0, Math.min(1, answer.noul));
  }
  if (answer.probabilities !== undefined && typeof answer.probabilities === 'object') {
    const normalized = normalize(answer.probabilities);
    for (const key of ['true', 'yes']) {
      const value = normalized[key]                      ;
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    }
  }
  return undefined;
}

export function createS1Relevance(opts                    )              {
  const stats                   = { calls: 0, questions: 0, inputTokens: 0, outputTokens: 0, lastMs: 0, failures: 0 };
  const perCall = Math.max(1, Math.trunc(opts.questionsPerCall ?? 16));

  const scoreBatch = async (current         , candidates                    )                                         => {
    if (candidates.length === 0) return [];
    const started = (opts.now ?? Date.now)();
    const questions                                          = {};
    const index           = [];
    for (let i = 0; i < candidates.length; i += 1) {
      // The window is asked about in batches bounded by the caller's cap. A cap reached is a real limit, not a
      // silent truncation, so it is reported once and the remaining candidates simply get no weight.
      if (i > 0 && i % perCall === 0) {
        opts.onWarn?.(`[s1cap] relevance: window of ${candidates.length} exceeds questionsPerCall=${perCall}; the rest is unscored`);
        break;
      }
      const id = `h${i}`;
      questions[id] = noul(
        `Does retrieving this candidate help answer or continue the current segment?\n\n` +
        `Current segment:\n${render(current)}\n\n` +
        `Candidate h${i}:\n${render(candidates[i]           )}`,
        {
          true: 'retrieving the candidate would help with the current segment',
          false: 'the candidate is unrelated or a distraction',
        },
      );
      index.push(i);
    }
    if (index.length === 0) return undefined;

    let answers                                                              ;
    try {
      const result = await opts.decide(
        // The state is the current segment: one System-1 call judges how useful the listed candidates are for
        // it, which is the direction the design asks for (h_i's reference value for s_j, not string overlap).
        { kind: current.kind, text: render(current) },
        questions,
      );
      answers = result.answers;
      stats.calls += 1;
      stats.inputTokens += result.usage?.input_tokens ?? 0;
      stats.outputTokens += result.usage?.output_tokens ?? 0;
    } catch (err) {
      stats.failures += 1;
      opts.onWarn?.(`[s1cap] relevance call failed (falling back to lexical scoring): ${String(err)}`);
      return undefined;
    }
    stats.questions += index.length;
    stats.lastMs = Math.max(0, (opts.now ?? Date.now)() - started);

    const weights           = [];
    for (const i of index) {
      const answer = answers[`h${i}`]                                   ;
      const weight = readWeight(answer);
      if (weight === undefined) {
        stats.failures += 1;
        opts.onWarn?.(`[s1cap] relevance: no usable weight for candidate h${i}; the whole batch falls back`);
        return undefined;
      }
      weights.push(weight);
    }
    // Aligned by candidate index, so a partial batch is impossible to misread as a full one.
    const out = new Array        (candidates.length).fill(0);
    index.forEach((candIndex, k) => {
      out[candIndex] = weights[k]          ;
    });
    return out;
  };

  const relevance = scoreBatch               ;
  (relevance                       ).stats = () => ({ ...stats });
  return relevance;
}
