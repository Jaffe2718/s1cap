/**
 * PLAN GATE — candidate plans, scored by one System-1 choice call, in an advisory order.
 *
 * This is the right-hand column of the method figure: `candidate plans` -> `choice scores` -> `advisory order ·
 * never vetoes stop`. The core half (`orderPlans`, `normalizeProbs`, `AttemptController`) has existed since the
 * beginning and was called by nobody, so the figure described a part of the system that was written down and not
 * running. This file is the wiring, and it is deliberately incapable of the one thing that would make it
 * dangerous:
 *
 *   **It never changes what the model sees or whether the turn ends.** The order is computed, recorded in the
 *   control plane, and returned to whoever asks. There is no code path from a gate decision to a prompt or to a
 *   stop. The figure says "never vetoes stop" and that is a property of the absence of a call site, not a check
 *   somebody remembered to write.
 *
 * Where the plans come from: the model's own output. A plan is a candidate only if the model wrote it down as
 * one - a numbered or bulleted step in an assistant message. S1CAP never invents a plan, so the gate can only
 * ever reorder something the model already decided to do, which is what makes an advisory order meaningful
 * rather than a second opinion that quietly replaced the first.
 */
import { choice, normalize } from '@s1cap/s1-client';
                                                     

                                                                              
import { TELEMETRY_SCHEMA_VERSION, orderPlans } from '@s1cap/core';

const MAX_SUMMARY_CHARS = 400;
/** m <= 3 by policy; longer lists are truncated here so the cap is enforced in one place. */
const MAX_PLANS = 3;

                                  
                                                                                                         
                                    
                                 
                 
 

                           
     
                                                                                                       
                                                                                                           
                                                               
     
                                                                                                 
     
                                                                                                    
    
                                                                                                            
                                                                                                               
                                                                                                                 
                                                                                                                
                                                             
     
                                                                                                                    
                         
 

                                
                                     
                    
                                                         
                    
                                               
                
                                                                             
                    
                                                  
                  
                                                                                                               
                     
                                                                                
                        
 

/**
 * The host's todo item, as declared in its own type catalog:
 * `{ content: string; status: 'pending' | 'in_progress' | 'completed' }`.
 */
                           
                  
                                                  
 

/**
 * Read the todos out of a `todo/write` session event, or `undefined` when this event is not one.
 *
 * Defensive on purpose. The shape is verified in the host's own type catalog, but the session-event stream is
 * `unknown` at the boundary and a host build that renames the field must cost one event rather than a session:
 * an item without a string `content` or an unrecognised `status` is skipped, everything else is passed through
 * as the host logged it. A plan list S1CAP could not read is a missing decision, which is the same outcome as no
 * plan at all, and it says so in the stats instead of pretending to have gated something.
 */
export function extractTodoEvent(event         )                         {
  if (typeof event !== 'object' || event === null) return undefined;
  const envelope = event                                      ;
  if (envelope.type !== 'todo/write') return undefined;
  if (typeof envelope.data !== 'object' || envelope.data === null) return undefined;
  const todos = (envelope.data                       ).todos;
  if (!Array.isArray(todos)) return undefined;
  const read             = [];
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) continue;
    const { content, status } = todo                                           ;
    if (typeof content !== 'string') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
    read.push({ content, status });
  }
  return read.length > 0 ? read : undefined;
}
/**
 * Read the model's plan out of a `todo/write` event.
 *
 * Pending and in-progress steps, in the order the host logged them, and completed ones dropped: a plan the model
 * has already finished is not a step it is about to choose between, and including them would let the gate rank
 * work that is already behind it. The host's order is the model's own order, which is what the gate is there to
 * compare against — re-sorting the list here would destroy the baseline it is measured on.
 */
export function extractTodos(todos                     , maxPlans = MAX_PLANS)                  {
  const plans                  = [];
  for (const todo of todos) {
    if (todo.status === 'completed') continue;
    const summary = todo.content.trim();
    if (summary === '') continue;
    plans.push({
      id: `p${plans.length + 1}`,
      summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}...` : summary,
    });
    if (plans.length >= Math.max(1, Math.trunc(maxPlans))) break;
  }
  return plans;
}

/**
 * Read the model's own plan list out of an assistant message.
 *
 * Deliberately strict about the format: a line that is a numbered or bulleted step, with text after it. Prose
 * containing a "-" in the middle of a sentence is not a plan, and a gate that invents plans from prose would be
 * reordering work the model never proposed.
 */
export function extractPlans(text        , maxPlans = MAX_PLANS)                  {
  const plans                  = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(?:\d+[.)]|[-*+])\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    const summary = (match[1] ?? '').trim();
    if (summary === '') continue;
    plans.push({
      id: `p${plans.length + 1}`,
      summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}...` : summary,
    });
    if (plans.length >= Math.max(1, Math.trunc(maxPlans))) break;
  }
  return plans;
}

export function createPlanGate(
  opts                 ,
  decide                                                                                      
                                     
                                                            
    ,
)           {
  const stats                = {
    inspected: 0,
    withPlans: 0,
    calls: 0,
    abstained: 0,
    skipped: 0,
    todoEvents: 0,
    todoWithPlans: 0,
  };

  /**
   * Score a list of candidates, whoever wrote it down. Shared so the two sources cannot drift apart: the
   * question, the normalization, the abstain rule and the emitted record are one decision, and a tool-written
   * plan must be gated by the same gate as a text-written one or the ablation is comparing two different gates.
   *
   * `task` is what the model wrote in the same event, used as the question's context. For a todo list that is
   * the todos themselves — the task is not stated in a `todo/write` event, and inventing one from the session
   * would put text S1CAP composed into a System-1 question.
   */
  const scorePlans = async (
    plans                 ,
    task        ,
  )                                        => {
    if (!opts.policy.planGate.on || decide === undefined) {
      stats.skipped += 1;
      return undefined;
    }
    // One candidate is not an ordering decision; two is the smallest case where the gate can differ from the
    // model's own order at all.
    if (plans.length < 2) {
      stats.skipped += 1;
      return undefined;
    }

    const question = choice(
      'The task is to carry out these candidate plans. Which plan should be executed first? ' +
        'Judge by which one unblocks the others and by how much it reduces risk if it fails.',
      Object.fromEntries(plans.map((p) => [p.id, p.summary])),
    );

    let scores             ;
    try {
      const result = await decide(
        { task: task.slice(0, MAX_SUMMARY_CHARS * 2), plans: plans.map((p) => ({ id: p.id, summary: p.summary })) },
        { first: question },
      );
      stats.calls += 1;
      const answer = result.answers['first']                            ;
      if (answer === undefined || answer.probabilities === undefined) {
        // No readable answer is an abstention, not an ordering: the model's own order stands.
        stats.skipped += 1;
        return undefined;
      }
      // Jev does not guarantee the probabilities sum to one, so they are normalized before use - and the
      // normalization is the same function the graph uses for relevance, so the two agree on what a
      // probability is.
      const probs = normalize(answer.probabilities                          );
      scores = plans.map((p) => ({
        id: p.id,
        prob: probs[p.id] ?? 0,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
      }));
    } catch (err) {
      opts.onWarn?.(`[s1cap] plan scoring failed (keeping the model's own order): ${String(err)}`);
      stats.skipped += 1;
      return undefined;
    }

    const decision = orderPlans(plans, scores, opts.policy.planGate.abstainConfidence);
    if (decision.abstained) stats.abstained += 1;
    // The record carries the advice, not an action. `executed` is empty and `verified` false in this milestone
    // because nothing here executes: the gate's order is computed, recorded and returned, and the harness runs
    // the model's own plans. Those two fields exist in the frozen schema for when the harness does hand the
    // order over, and leaving them at their empty values is what says "advisory" in the log.
    const ordered = decision.order;
    opts.emit({
      type: 'plan_gate',
      schema: TELEMETRY_SCHEMA_VERSION,
      ts: (opts.now ?? Date.now)(),
      plans: ordered,
      probs: ordered.map((id) => decision.probs[id] ?? 0),
      confidence: ordered.map((id) => scores.find((s) => s.id === id)?.confidence ?? 0),
      order: ordered,
      abstained: decision.abstained,
      executed: [],
      verified: false,
      savedTokensEst: 0,
    });
    return decision;
  };

  const consider = async (text        , sessionId        , step        )                                        => {
    stats.inspected += 1;
    const plans = extractPlans(text, opts.policy.planGate.maxPlans);
    if (plans.length >= 2) stats.withPlans += 1;
    return scorePlans(plans, text);
  };

  const considerTodos = async (
    todos                     ,
    sessionId        ,
    step        ,
  )                                        => {
    stats.todoEvents += 1;
    const plans = extractTodos(todos, opts.policy.planGate.maxPlans);
    if (plans.length >= 2) stats.todoWithPlans += 1;
    // The task context is the model's own words from the same event: the pending steps, in its order. No other
    // text goes into the question, for the same reason nothing goes into the model's context.
    const task = plans.map((p) => p.summary).join('; ');
    return scorePlans(plans, task);
  };

  return { consider, considerTodos, stats: () => ({ ...stats }) };
}
