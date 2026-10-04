/**
 * CONTEXT DELIVERY — putting the assembled view in front of the model.
 *
 * This module was written once before, and the first version was wrong in a way that took a live session to
 * discover. It rewrote `decision.messages` into a whole model view: pinned prefix, then the state proxy, the
 * recalled block, the tail, the current turn, in the assembler's order. It was well-formed, it was tested, and
 * in the live run it reported `delivered: false, messagesBefore: 1` four times over. The reason is in the
 * packaged harness, and it is not a defect in the layout:
 *
 *   // dsh-agent-loop/lib/index.js — preStep()
 *   const claimed = this.inbox.claim(target, position.turn);
 *   const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
 *   const context = this.runtimeContext.project(joinContextSections(renderContextSections(assembly)));
 *   const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ... },
 *     () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));
 *
 *   // dsh-agent-loop/lib/index.js — step(decision)
 *   for (const { message, intent } of commits) this.session.append("system/message", { ... }, intent);
 *   if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, ...);
 *   const request = this.buildRequest(config, preparedCall, assembly.tools, ...);
 *   const stream = this.loopCtx.llm.stream(request);
 *
 * `decision.messages` is the step's increment — `claimed`, plus one projected context message — not the history.
 * The history lives in the session log, and the request is built from that log. So two things follow, and they
 * are the whole contract of this rewrite:
 *
 * 1. What this module can do is *insert*, and it is the harness's own channel: a message returned here is
 *    appended to the log and is in the next request. `dsh-agent-instructions` does exactly this, in production,
 *    and its shape is the one copied below.
 * 2. What this module cannot do is *suppress*. Nothing reachable from a plugin removes a message the log already
 *    holds. A design that claimed otherwise would leave the log asserting one thing and the model seeing
 *    another, which is the failure this project keeps meeting in other clothes.
 *
 * The precedent, verbatim from `dsh-agent-instructions/lib/index.js`:
 *
 *     ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
 *       const decision = await next();
 *       const desired = await compose(agent, signal, messages, pending);
 *       if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) { ...; return decision; }
 *       for (const message of pending) agent.inbox.remove(message.id);
 *       if (desired === void 0 || decision.messages.some((m) => sameContextPayload(m, desired))) return decision;
 *       const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
 *       const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
 *       return { ...decision, messages: entered };
 *     });
 *
 * Four rules come out of it, and each exists because its absence is a real failure:
 *
 * - Insert *after the last claimed message*. The claimed messages are what the harness will append to the log
 *   for this step, so that is where a block about the current turn belongs; earlier would put it before the
 *   question it answers. When this step claimed nothing the block goes at the end of the increment instead,
 *   which for an empty one is the same position — and that branch is reachable only when the caller says the
 *   step issues a request anyway (`trigger` below).
 * - Remove the previous injection from the inbox, and skip when an equal payload is already present. A delivered
 *   block becomes part of the log, so without this it is re-delivered every step and the log grows one copy per
 *   step until the context is nothing but S1CAP's own output.
 * - Never remove or rewrite a message this module did not add. Claimed messages, the pinned prefix and the tail
 *   are the harness's transcript, and a tool result among them carries a `tool_call_id` the provider matches.
 * - Refuse on a rejected step, and report a skip instead of hiding it: "assembled" and "delivered" are different
 *   states, and every counter in this project used to report the first while the experiments needed the second.
 *
 * ### What changed on 2026-10-04: the state proxy `T` is delivered, through this same channel
 *
 * The method this project ports is a placement contrast on a second pass, and the whole of it is the variable `T`:
 *
 *     Trace as State:   M([T, x, q])     trace BEFORE the long context
 *     Trace Append:     M([x, T, q])     the same trace, AFTER the long context (the control)
 *
 * "Trace as State" (arXiv 2609.02702) §3.2 is the source: `T` is the model's own reasoning trace, serialized in
 * source order by a fixed serializer that "preserves the included reasoning text in source order and adds fixed
 * labels and delimiters". S1CAP computed `T`, recorded it on every assembly, budgeted for it, and then dropped it:
 * the loop below walked past the `stateProxy` slot, so C0, C1 and C2 all presented the *same* value of the one
 * variable the headline result is about. `docs/STATUS.md` §N6 carried "may an authored state proxy `T` be
 * delivered at all" as an open question. The paper settles it: the method *is* the delivery of `T`.
 *
 * None of the four rules above changes, and each of them is why this is an insertion rather than a rewrite:
 *
 * - The anchor is untouched, so `T` lands after the last claimed message exactly like the quoted turns do.
 * - Nothing is removed or rewritten, so every harness message this module did not add is as untouched as it was
 *   before `T` existed; `dropped` is still 0 and `kept` is still `messages.length`.
 * - The duplicate check is *not* weakened by the addition. The payload digest is computed over the whole delivered
 *   text, so an unchanged `T` beside an unchanged selection is refused exactly as before, and a changed `T` is a
 *   genuinely new payload - which the per-session payload-id set in `index.ts` then also treats as new, because it
 *   keys on the same digest. That is the rule working, not the rule being bent: `updatePolicy: perTask` (the
 *   default in C1 and C2) makes `T` byte-stable within a task, so a long turn does not re-deliver it per step.
 *
 * **What is still not reachable from here, stated rather than glossed.** The insertion anchor fixes the delivered
 * message *after* the current turn's own messages, so what the model reads is `[..., x, T, recalled, ...]`: `T` is
 * before the long context, which is the half the method is named for, and it is after `x`, which the paper's
 * `[T, x, q]` is not. Reproducing the paper's literal order needs a channel that delivers the whole layout, which
 * `docs/ARCHITECTURE.md` carries as the `packages/proxy` write-back and this file explicitly is not. This change
 * makes the *variable* real; it does not make the layout order real.
 */

import { S1CAP_INJECTED_ID_PREFIX } from '@s1cap/core';
                                                   

/** A segment as far as delivery is concerned: id and text for rendering, chunkOf for chunk parents. */                                     
             
               
               
                   
 

/**
 * What this module needs to build the model view, and the switch that decides whether it may.
 *
 * `trigger` is `policy.assemblyTrigger`, passed through by the caller: which steps the caller assembles on.
 * `'claimed-only'` keeps the guards in `deliverContext` exactly as this module shipped them. `'every-step'` — the
 * default since 2026-10-04, because the brief requires recall on the model's own self-directed input — is
 * the caller asserting that this step will issue a model request although its decision carries no messages — the
 * packaged loop appends the decision and then streams the request built from the session log regardless — and it
 * is what makes the end-insertion branch reachable for an *empty* decision, which was the unreachable half this
 * file's own guard comment used to record. It is required, so a caller has to state which mode it is in, and the
 * runtime test is written as `!== 'every-step'`: a missing or unexpected value is the conservative one and never
 * a silent delivery into an empty step.
 */
                                       
                                                                                               
                   
                                                                                             
                           
     
                                                                                                    
    
                                                                                                             
                                                                                                                   
                                                                                                                
                                                                                                             
                                                                                                                   
                                                               
    
                                                                                                                 
                                                                                                                 
                                                                                                            
                                                                                                           
     
                      
                                          
     
                                                                                                                 
                                                                                                                   
                                                  
     
                             
                                                        
                               
     
                                                                                                              
                                                                                                                
                                          
     
                               
                                                                                               
                
                           
 

                                        
                                                                                               
                     
                                                                                
                 
                                                                                   
                             
     
                                                                                          
    
                                                                                                                  
                                                                                                                  
                                                                                                                  
     
                   
                                                       
               
                                                                                         
                  
                                     
                   
                                                                                    
                    
 

const NOT_DELIVERED = (reason        , blocks           = [])                        => ({
  delivered: false,
  reason,
  messages: null,
  blocks,
  kept: 0,
  dropped: 0,
  inserted: 0,
  payloadId: '',
});

function isRecord(value         )                                   {
  return typeof value === 'object' && value !== null;
}

/**
 * A stable id for a set of blocks.
 *
 * The same blocks in the same order must produce the same id on later steps, because that is what the
 * "already delivered" check compares. It is derived from the rendered text, so it changes exactly when the
 * content the model would see changes — including when a block is added or dropped, which is the point.
 *
 * The prefix is the core's marker, not a local convention: `isS1capInjected` uses it to keep these blocks out of
 * the recall candidates, and a digest whose prefix drifted from that marker would make the recursion
 * unfixable from here — the exact failure a live run measured, where one injection recalled the previous one.
 */
function payloadIdFor(text        )         {
  // FNV-1a, 32-bit, hex. Not a security primitive: a digest whose only job is to notice "same text as last
  // time" without holding a second copy of the text.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${S1CAP_INJECTED_ID_PREFIX}${hash.toString(16).padStart(8, '0')}`;
}

function textOf(message         )         {
  if (!isRecord(message)) return '';
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    .join('');
}

function renderSegment(seg                    )         {
  const parent = seg.chunkOf ?? seg.id;
  // A provenance line, and nothing else. The segment's own text follows verbatim.
  //
  // This is the whole shape of the block, and it is a correction. It used to open with S1CAP prose - "the blocks
  // below were selected by relevance to the current task, they supplement the transcript" - which is S1CAP
  // writing *about* the context into the conversation, under a rule that says S1CAP manages the harness's own
  // context and contributes no text of its own. And a bare concatenation would be worse than either: an earlier
  // turn re-sent as a fresh user message reads as something the user just said, which is a distortion of the
  // transcript rather than a convenience. One line naming where the text came from is the minimum that keeps the
  // distinction honest, and it is a label rather than content.
  return `## earlier ${seg.kind} turn, quoted verbatim · ${parent}\n${seg.text}`;
}

/**
 * The paper's fixed delimiters (§3.2), exported because they are the delivered format and a reader of the request
 * needs to know them: the serializer "adds fixed labels and delimiters", and those are the labels. They are what
 * makes `T` legible as a *trace block* rather than as a fresh user message — which matters because the harness
 * appends the injected message to the log as a `user` message, and an undelimited summary in that position reads
 * as something the user said.
 *
 * These live here rather than in `packages/core/src/state-proxy.ts` on purpose: they are the names of the wire
 * delimiters, and both modules have to agree on them. Core owns the content AND the frame; this file owns the
 * composition of the injected message (which blocks, in what order, joined how).
 *
 * That split was wrong in the first version of this pair, and the way it was wrong is worth keeping: this file
 * wrapped `T` in the delimiters because the paper's §3.2 sentence - "the serializer π ... adds fixed labels and
 * delimiters" - was read as a wire concern, while the serializer in core emitted them too because the same
 * sentence makes π itself the thing that adds them. π is core's module, so the delimiters are core's, and the
 * result of the two readings meeting was a doubled pair in the model's context: `<trace_start>` / intro /
 * `<trace_start>` / trace / `<trace_end>` / `<trace_end>`. Measured in round `20261004-0205`, both delivering
 * cells, and the guard below did not catch it because it tested `startsWith` against a body that begins with the
 * intro line rather than with the delimiter.
 */
export const TRACE_START = '<trace_start>';
export const TRACE_END = '<trace_end>';

/**
 * `T` as it goes on the wire: the serializer's own text, **verbatim**, passed through untouched.
 *
 * Verbatim is the whole contract. `T` is derived, not generated — every line in it is the model's own text or a
 * tool call it made (`state-proxy.ts`) — and re-writing it here would put S1CAP's words into the model's context
 * in the one place the method requires the model's own words. Rewriting would include re-framing it: the frame is
 * part of what the serializer produces, so adding one here produces two.
 *
 * A body that is empty is the one thing handled: `tas.on` with no anchor yields `''`, and an empty block must
 * cost zero tokens and occupy no line in the message.
 */
function renderStateProxy(text        )         {
  return text.trim();
}

/**
 * Build the list of messages the model is shown, or report why it cannot.
 *
 * The delivered list is the harness's own list with one message added. Nothing is removed, reordered or
 * rewritten, because the request is built from the session log and anything else here would be a claim the
 * model does not see.
 */
export function deliverContext(input                      )                        {
  if (!input.enabled) return NOT_DELIVERED('policy.deliver is off: the cell leaves context to the harness');
  // The harness's own guard, kept for the same reason it is kept there: a first step with nothing claimed is
  // not a step at all. Checked before the general "no messages" case so the recorded reason is the specific one
  // rather than a true but useless restatement of it.
  //
  // **And this module's guards are the only place that rule is reachable**, which `docs/STATUS.md` used to state
  // the other way round: it said a step with nothing claimed must insert at the **end**, since index 0 would put a
  // note about the task ahead of the system instructions. The insertion point below still implements exactly that
  // (`at < 0 -> messages.length`), and it is reachable for the case the doc names first - an *empty* decision -
  // exactly when the caller passes `trigger: 'every-step'`, which is the switch this file used to say it did not
  // have: it recorded the doc and the guard as contradicting each other on this point and left them that way
  // because "the refusal's *reason* is the open question". It is still the open question, and it is now the
  // **caller's** to answer per step rather than this module's to answer for everyone:
  //
  //   - `'claimed-only'`: both refusals are unchanged, so an empty decision is declined here exactly as it was.
  //     This was the default until 2026-10-04, and round `20261004-0205` ran it — 2 assemblies in C2's 53 steps.
  //   - `'every-step'`: the caller has asserted that the harness will build a request from this step anyway, so
  //     only the *general* refusal is lifted — the block goes at the end and the step is left otherwise alone.
  //     The empty decision is still both things at once (a step the loop may stop on, and a step that sent a
  //     request: round `20261003-2104` records 33 steps, 33 `LLM calls`, one per step, turn ended
  //     `1:completed`), and this module is not the place that decides which one a given step is.
  //
  // The first-step guard is *not* lifted by `'every-step'`: the harness's own `step === 1 && messages.length === 0`
  // is a turn-boundary test, the host's own instructions plugin declines there too, and the evidence above is
  // about the steps after the first.
  if (input.step === 1 && input.messages.length === 0) {
    return NOT_DELIVERED('step 1 with no claimed messages: the harness treats this as no step at all');
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    // Lifted for the empty list under `every-step`, and for the empty list only: a decision whose `messages` is
    // not a list at all is a shape this module does not understand, and inserting a list where the harness had
    // something else would be a rewrite rather than the insertion the header promises.
    const emptyList = Array.isArray(input.messages) && input.messages.length === 0;
    if (!emptyList || input.trigger !== 'every-step') {
      return NOT_DELIVERED('the decision carried no messages');
    }
  }

  // Two kinds of block now go into the one inserted message, and the state proxy is first.
  //
  // **This paragraph used to argue the opposite, and the argument was wrong.** It read: T is a summary S1CAP writes,
  // so delivering it would put S1CAP's own text into the model's context, "the same category as the prose that was
  // removed from this block earlier", and the requirement is that S1CAP's operations do not enter the LLM's context
  // at all. That requirement is real and it still holds for *prose* — it is why this file carries no preamble and
  // no explanation. What it does not hold for is `T`, and the error was treating them as the same kind of thing.
  // They are not: the prose was S1CAP writing *about* the context into the conversation, which is a category error
  // under any reading. `T` is the model's own trace, serialized; the paper's method is the delivery of it, and
  // "S1CAP adds nothing of its own" is true of it in the only sense that matters — every line in `T` is a rendering
  // of something the model said or a tool returned (`packages/core/src/state-proxy.ts`), never a sentence S1CAP
  // wrote about the model. Consequence, and it is the whole point of the change: until this line changed, C0, C1 and
  // C2 all presented the *same* value of the variable the paper's headline result is about.
  //
  // **`T` first, and not because `order` says so.** The paper's contrast is about `T`'s position relative to the
  // long context, and the long context here is the `recalled` block — so `T` goes before it, whatever the layout
  // order happens to be. `order` is walked only for `recalled`: depending on the assembler's own slot name for `T`
  // would couple delivery to a token this module does not own, and would fail *silently* — an empty delivered list
  // is a valid answer — if that token were ever renamed.
  //
  // `T` alone is a delivery. A cell with `tas.on` and an empty selection (`recall.tier1: 'off'`) used to have
  // nothing to insert at all; it now has exactly the thing the method is about, and the block count on the record
  // says so. That is a change of what such a cell *is*, not a tuning detail, and it is why the delivery is reported
  // rather than inferred.
  const proxy = renderStateProxy(typeof input.stateProxy === 'string' ? input.stateProxy : '');
  const parts           = [];
  const blocks           = [];
  if (proxy !== '') {
    parts.push(proxy);
    blocks.push('stateProxy');
  }
  for (const block of input.order) {
    if (block === 'recalled') {
      for (const seg of input.recalled) {
        parts.push(renderSegment(seg));
        blocks.push('recalled');
      }
    }
  }
  if (parts.length === 0) {
    // Nothing selected and no `T` to send. Delivering an empty block would cost tokens on every step of every turn
    // and tell the model nothing, so the step is left exactly as the harness built it. The reason is kept
    // character-for-character: `cell-report.mjs` and the refusal counts are read through this string.
    return NOT_DELIVERED('nothing to insert: relevance selected no turns');
  }

  // No preamble, no explanation, no instruction. What the model reads is `T` inside the paper's delimiters and
  // quoted session content with a provenance line, and nothing else — in that order, because the trace is what the
  // information is for.
  const text = parts.join('\n\n');
  const payloadId = payloadIdFor(text);

  // Already delivered: the previous injection is part of the log and comes back through the decision, so
  // re-adding it every step would grow one copy per step. The check has to be content-based, because the id in
  // the log is the harness's own, not this one — the harness checks the same way (`sameContextPayload`).
  //
  // **This check cannot fire in production, and that is a fact about the harness rather than a bug to fix here.**
  // `decision.messages` is `inbox.claim(...)` plus one projected context message: `claim` *removes* what it
  // returns, and a message appended to the session (the channel this module's insert takes) never enters the
  // inbox at all. So the previous injection does not come back through the decision - the round's tape proves it,
  // with the payload's message count `{0: 276, 1: 1}` over all 277 steps and the single non-empty one carrying the
  // human prompt, not the block. The unit test below passed only because it fed the old payload back by hand. It
  // is kept as the cheap first test and as the correct rule *if* some other middleware ever re-splices the block
  // into an inbox; the guard that actually runs is the per-session payload-id set in `index.ts`
  // (`preStepMiddleware`), which keys on what S1CAP itself delivered instead of on what the harness hands back.
  //
  // Under `trigger: 'every-step'` this loop scans an empty list on exactly the steps the switch is for, so the
  // per-session set in `index.ts` is not a second line of defence there - it is the only one, and it is what
  // bounds a round's deliveries to one per distinct payload per session (DEFECT-GATE.md, Update 5, item 5). It
  // has to keep working; `observer.test.ts` pins it on this path rather than only on a decision that claimed.
  for (const message of input.messages) {
    if (textOf(message) === text) {
      return NOT_DELIVERED('this exact context is already in the transcript: not delivered twice', blocks);
    }
  }

  const injected = {
    // A fixed id would collide with the previous injection as soon as both were in one list, so the id carries
    // the payload digest; the harness's own id, which the inbox assigns, is what a removal would key on.
    id: payloadId,
    role: 'user',
    content: [{ type: 'text', text }],
    // 'system-prompt' is the injected-context kind the adapter already enumerates; an invented kind would be
    // read by nothing and would quietly move where the harness counts its own instructions from.
    source: { kind: 'system-prompt', form: 's1cap', summary: 's1cap assembled context' },
  };

  // The insertion point, computed as dsh-agent-instructions computes it: after the last message the harness
  // will append to the log for this step. A manual scan rather than `findLastIndex` because the claimed array
  // may legitimately be absent, and a missing array is a fact to handle rather than a method to call.
  const messages = input.messages             ;
  const claimed = Array.isArray(input.claimed) ? input.claimed : [];
  let at = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (claimed.includes(messages[i])) at = i;
  }
  // `at === -1` means nothing in the decision belongs to the claimed list — a step that claimed nothing, or a
  // payload that carried no `messages`. The block then goes at the end. Inserting at index 0 instead would put
  // it ahead of the system prefix, which is the one position guaranteed to be wrong: it breaks the cache-stable
  // head and puts a note about the task before the instructions that define it.
  //
  // For an *empty* increment — the state `'every-step'` is what makes reachable — `messages.length` is 0, so the
  // end and index 0 are the same position, and it is still the end of what the harness will append for this step.
  const index = at < 0 ? messages.length : at + 1;
  const delivered = [...messages.slice(0, index), injected, ...messages.slice(index)];

  return {
    delivered: true,
    // Two sentences, because the two insertions are different facts and the record has to be readable without the
    // step's decision beside it: a block placed after the question this step asked, and a block placed at the end
    // of an increment that claimed nothing at all (the `'every-step'` case, where the payload's message count is 0
    // and this message is the whole of the step's increment).
    reason:
      at < 0
        ? `inserted one message at the end of the step's increment (index ${index} of ${messages.length}; nothing ` +
          `in the decision was claimed) carrying ${blocks.length} block(s): ${blocks.join(', ')}; nothing removed ` +
          `or rewritten`
        : `inserted one message after the last claimed message (index ${index} of ${messages.length}) carrying ` +
          `${blocks.length} block(s): ${blocks.join(', ')}; nothing removed or rewritten`,
    messages: delivered,
    blocks,
    kept: messages.length,
    dropped: 0,
    inserted: 1,
    payloadId,
  };
}
