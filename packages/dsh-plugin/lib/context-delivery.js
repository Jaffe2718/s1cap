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
 *   question it answers.
 * - Remove the previous injection from the inbox, and skip when an equal payload is already present. A delivered
 *   block becomes part of the log, so without this it is re-delivered every step and the log grows one copy per
 *   step until the context is nothing but S1CAP's own output.
 * - Never remove or rewrite a message this module did not add. Claimed messages, the pinned prefix and the tail
 *   are the harness's transcript, and a tool result among them carries a `tool_call_id` the provider matches.
 * - Refuse on a rejected step, and report a skip instead of hiding it: "assembled" and "delivered" are different
 *   states, and every counter in this project used to report the first while the experiments needed the second.
 */

import { S1CAP_INJECTED_ID_PREFIX } from '@s1cap/core';

/** A segment as far as delivery is concerned: id and text for rendering, chunkOf for chunk parents. */                                     
             
               
               
                   
 

                                       
                                                                                               
                   
                                                                                             
                           
                                                        
                      
                                          
                                                                                                               
                             
                                                        
                               
     
                                                                                                              
                                                                                                                
                                          
     
                               
                                                                                               
                
 

                                        
                                                                                               
                     
                                                                                
                 
                                                                                   
                             
                                                                                             
                   
                                                       
               
                                                                                         
                  
                                     
                   
                                                                                    
                    
 

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
  if (input.step === 1 && input.messages.length === 0) {
    return NOT_DELIVERED('step 1 with no claimed messages: the harness treats this as no step at all');
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return NOT_DELIVERED('the decision carried no messages');
  }

  // Only the two blocks that are additions. `pinned` is the harness's system prompt; `tail` and `anchor` are
  // already in the transcript, and re-sending them here would duplicate text the model can already see.
  const parts           = [];
  const blocks           = [];
  for (const block of input.order) {
    if (block === 'stateProxy') {
      const text = input.stateProxy;
      if (typeof text === 'string' && text !== '') {
        // Labelled as authored, because it is: T is a summary S1CAP wrote, not a quotation. The recalled
        // segments below are quoted verbatim and say so; this one must not read as if it were. Whether an
        // authored T may be delivered at all is an open question about the method (docs/STATUS.md), not something
        // to decide by quietly labelling it.
        parts.push('## state proxy T, written by S1CAP from this session\n' + text);
        blocks.push('stateProxy');
      }
    } else if (block === 'recalled') {
      for (const seg of input.recalled) {
        parts.push(renderSegment(seg));
        blocks.push('recalled');
      }
    }
  }
  if (parts.length === 0) {
    // No state summary and nothing selected. Delivering here would add a bare header on every step of every
    // turn, costing tokens and telling the model nothing.
    return NOT_DELIVERED('nothing to insert: no recalled block and no state proxy');
  }

  // No preamble, no explanation, no instruction. What the model reads is quoted session content with a
  // provenance line, and nothing else.
  const text = parts.join('\n\n');
  const payloadId = payloadIdFor(text);

  // Already delivered: the previous injection is part of the log and comes back through the decision, so
  // re-adding it every step would grow one copy per step. The check has to be content-based, because the id in
  // the log is the harness's own, not this one — the harness checks the same way (`sameContextPayload`).
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
  const index = at < 0 ? messages.length : at + 1;
  const delivered = [...messages.slice(0, index), injected, ...messages.slice(index)];

  return {
    delivered: true,
    reason:
      `inserted one message after the last claimed message (index ${index} of ${messages.length}) carrying ` +
      `${blocks.length} block(s): ${blocks.join(', ')}; nothing removed or rewritten`,
    messages: delivered,
    blocks,
    kept: messages.length,
    dropped: 0,
    inserted: 1,
    payloadId,
  };
}
