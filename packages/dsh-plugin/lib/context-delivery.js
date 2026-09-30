/**
 * CONTEXT DELIVERY — putting the assembled view in front of the model.
 *
 * Until this existed, the whole pipeline stopped one step short of the thing it is for. The segmenter produced
 * segments, the graph held edges, relevance scored them with a real System-1 backend, the assembler chose a
 * layout, the control-plane log recorded every block with its token count — and then `agent/pre-step` returned
 * the decision untouched, so the model was shown the harness's own full message list. The layout was a claim in
 * a JSONL file. This module is where that claim stops being a claim.
 *
 * The contract it relies on was read out of the packaged DSH source, not assumed:
 *
 *     const disposeNotice = agentCtx.on("agent/pre-step", async ({ agent, messages, signal, step }, next) => {
 *       const decision = await next();
 *       if (decision.kind === "reject" || signal.aborted) return decision;
 *       ...
 *       return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, selected)] };
 *     }, { prepend: true });
 *
 * Two things follow. The harness itself delivers context by returning `{...decision, messages}` — a model-switch
 * notice is added exactly this way, so a returned message list is what the model is actually shown. And the
 * message vocabulary is `{ id, role, content: [{type:'text', text}], source: {kind, ...} }`, from
 * `createUserMessage`; `source.kind` stays inside the set the adapter already enumerates ('system-prompt',
 * 'model', 'tool', 'model-selection') rather than inventing a kind the harness has never read.
 *
 * What is preserved, always, and why each one is non-negotiable:
 *
 * - The leading system/developer messages, verbatim and first. The pinned prefix is where the cache lives
 *   (`prefixTokensStable === blocks.pinned` is N1's acceptance criterion); reordering or rewriting it would
 *   throw away the one thing the layout is supposed to protect.
 * - The current turn's own message (`anchor`). Dropping the user message that is being answered is not a
 *   degraded answer, it is a broken round.
 * - The tail, verbatim, ids included. A tail message can be a tool result, and a tool result carries a
 *   `tool_call_id` the provider matches against an earlier call: re-rendering one as plain text turns a valid
 *   transcript into a rejected request. So tail messages are passed through as the same objects, never rebuilt.
 *
 * What is replaced is the middle: the history between the tail and the current task, which is exactly what the
 * recalled block is for. The delivered list is the layout's own order with 'pinned' dropped, because the pinned
 * block is the harness's system prompt and is not ours to place.
 *
 * Every path that cannot do this safely returns `delivered: false` with a reason, and the caller then returns the
 * original decision. The failure mode of the intervention is a no-op, never a broken round.
 */

/** A segment as far as delivery is concerned: id for matching, text for rendering, chunkOf for chunk parents. */
                                     
             
               
               
                   
 

                                       
                                                                                               
                   
                                                                                             
                           
                                                        
                      
                                          
                                      
                                           
                             
                                                        
                               
 

                                        
                                                                                 
                     
                                                                                 
                 
                                                                                   
                             
               
                  
                   
                                                                                                            
                                   
 

const NOT_DELIVERED = (reason        , mode                                = 'none')                        => ({
  delivered: false,
  reason,
  messages: null,
  kept: 0,
  dropped: 0,
  inserted: 0,
  mode,
});

function isRecord(value         )                                   {
  return typeof value === 'object' && value !== null;
}

function messageId(message         )                     {
  if (!isRecord(message)) return undefined;
  return typeof message.id === 'string' && message.id !== '' ? message.id : undefined;
}

function messageRole(message         )         {
  if (!isRecord(message)) return '';
  return typeof message.role === 'string' ? message.role : '';
}

/**
 * Render one segment as a message the harness can send.
 *
 * A user-role message with a single text part, which is the shape `createUserMessage` produces and the shape the
 * harness itself appends for a notice. The prefix states what the block is, so the model is not left guessing
 * whether the text is a recent turn or retrieved evidence — the distinction the whole method turns on.
 */
function renderSegment(seg                    , block        )          {
  const parent = seg.chunkOf ?? seg.id;
  return {
    id: `s1cap-${block}-${parent}`,
    role: 'user',
    content: [{ type: 'text', text: `[s1cap ${block} · ${seg.kind} · ${parent}]\n${seg.text}` }],
    // 'system-prompt' is the injected-context kind the adapter already enumerates; an invented kind would be
    // read by nothing and would quietly change the harness's own counting of where its instructions live.
    source: { kind: 'system-prompt', form: 's1cap', summary: `s1cap ${block}` },
  };
}

function renderProxy(text        )          {
  return {
    id: 's1cap-stateproxy',
    role: 'user',
    content: [{ type: 'text', text: `[s1cap state proxy T]\n${text}` }],
    source: { kind: 'system-prompt', form: 's1cap', summary: 's1cap state proxy' },
  };
}

/**
 * Build the list of messages the model is shown, or report why it cannot.
 *
 * `order` decides where the current task sits, and that is the entire content of the x-first/x-last claim: the
 * same selected history, with x in front of it or behind it. No block other than 'pinned' is placed here, because
 * the pinned block is the harness's own system prompt and already sits in front of `decision.messages`.
 */
export function deliverContext(input                      )                        {
  if (!input.enabled) return NOT_DELIVERED('policy.deliver is off: the cell leaves history to the harness');
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return NOT_DELIVERED('the decision carried no messages to rewrite');
  }
  const hasProxy = typeof input.stateProxy === 'string' && input.stateProxy !== '';
  if (input.recalled.length === 0 && !hasProxy) {
    // Nothing was selected and there is no state summary, so a delivery would only delete history. That is not
    // this module's decision to make on its own: the cell that wants pure trimming is a different experiment.
    return NOT_DELIVERED('nothing to insert: no recalled block and no state proxy');
  }

  const messages = input.messages             ;
  // 1. The pinned prefix: every leading system/developer message, verbatim and in place. Stop at the first
  //    message that is not one, so a later stray system message does not reorder the conversation.
  let head = 0;
  while (head < messages.length) {
    const role = messageRole(messages[head]);
    if (role !== 'system' && role !== 'developer') break;
    head += 1;
  }
  const pinnedPrefix = messages.slice(0, head);

  // 2. Which harness messages must survive verbatim: the tail, and the current turn's own message. Try ids
  //    first — a segment id is the harness's message id, so this is exact when it lines up. When it does not
  //    (the pre-step list can carry ids the session stream never saw), fall back to position: the tail is by
  //    construction the most recent segments, so the most recent messages are them. The mode is reported,
  //    because a positional match is a weaker claim than an exact one and a reader deserves to know which held.
  const wanted = new Set        ();
  for (const seg of [...input.tail, input.anchor]) wanted.add(seg.chunkOf ?? seg.id);
  const keepById = new Map                 ();
  for (const message of messages) {
    const id = messageId(message);
    if (id !== undefined && wanted.has(id)) keepById.set(id, message);
  }
  const mode                                = keepById.size > 0 ? 'id' : 'position';

  const keptTail            = [];
  if (mode === 'id') {
    // Keep the tail in the harness's own order (their relative order is part of the transcript), and the
    // anchor separately because the layout may put it on the other side of the recalled block.
    for (const message of messages) {
      const id = messageId(message);
      if (id !== undefined && wanted.has(id) && !keptTail.includes(message)) keptTail.push(message);
    }
  } else {
    // The trailing `1 + tail.length` messages, in order: the most recent history plus the current turn.
    keptTail.push(...messages.slice(Math.max(head, messages.length - (1 + input.tail.length))));
  }
  const anchorMessage =
    mode === 'id'
      ? (keepById.get(input.anchor.chunkOf ?? input.anchor.id) ?? keptTail[keptTail.length - 1])
      : keptTail[keptTail.length - 1];
  // The anchor is what the current turn is. If it cannot be identified, this delivery would answer a question
  // the model was never asked: refuse instead.
  if (anchorMessage === undefined) {
    return NOT_DELIVERED('the current turn\'s message could not be identified in the decision', mode);
  }

  // 3. Assemble the delivered list, block by block, in the assembler's order. 'pinned' is skipped on purpose:
  //    it is the harness's system prompt, already at the front of `messages`.
  const tailWithoutAnchor = keptTail.filter((m) => m !== anchorMessage);
  const delivered            = [...pinnedPrefix];
  let inserted = 0;
  for (const block of input.order) {
    switch (block) {
      case 'pinned':
        break;
      case 'stateProxy':
        if (hasProxy) {
          delivered.push(renderProxy(input.stateProxy          ));
          inserted += 1;
        }
        break;
      case 'anchor':
        delivered.push(anchorMessage);
        break;
      case 'recalled':
        for (const seg of input.recalled) {
          delivered.push(renderSegment(seg, 'recalled'));
          inserted += 1;
        }
        break;
      case 'tail':
        delivered.push(...tailWithoutAnchor);
        break;
      default:
        // An unknown block name is a layout this module does not implement. Refusing is correct: half a layout
        // is not a layout.
        return NOT_DELIVERED(`unknown layout block ${JSON.stringify(block)}: refusing a partial delivery`, mode);
    }
  }
  if (!delivered.includes(anchorMessage)) {
    // The layout did not place the current task at all. That is a layout bug, and delivering it would drop the
    // user's own question, so the original decision goes through untouched.
    return NOT_DELIVERED('the layout did not place the current turn in the delivered list', mode);
  }

  const keptCount = pinnedPrefix.length + keptTail.length;
  return {
    delivered: true,
    reason:
      `delivered ${delivered.length} messages (pinned ${pinnedPrefix.length}, inserted ${inserted}, ` +
      `tail ${tailWithoutAnchor.length}); dropped ${Math.max(0, messages.length - keptCount)} of the harness's ` +
      `${messages.length}; tail matched by ${mode}`,
    messages: delivered,
    kept: keptCount,
    dropped: Math.max(0, messages.length - keptCount),
    inserted,
    mode,
  };
}
