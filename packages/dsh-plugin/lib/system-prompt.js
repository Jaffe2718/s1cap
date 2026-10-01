/**
 * SYSTEM PROMPT SOURCE — N1.
 *
 * The rendered system prompt is not part of the `agent/pre-step` payload (verified in a real round: the
 * message list carried only the user turn), so it has to come from the harness's own registry. Facts read
 * from the packaged source (`dsh-system-prompt`, via `scripts/scan-dsh-asar.cjs --grep`):
 *
 *   async assemble(context = {}) { … }
 *     @param context - the optional scope and plugin-defined assembly fields.
 *     @returns the post-waterfall assembly with any complete prompt enforced.
 *
 * and the package also exports `renderPrompt(assembly)`, which turns that assembly into the string sent to
 * the model. Two consequences shape this module:
 *
 *   1. `assemble` is **async** and returns an assembly object, not text. (An earlier probe called it
 *      synchronously and inspected a Promise — which is why the assembly "looked empty".)
 *   2. This file deliberately does **not** import `@deepseek-ai/dsh-system-prompt`: adding the package to a
 *      profile install is a heavier change than N1 needs, and pulling it in only to render one string would
 *      tie the plugin to that package's version. Instead the assembly is read defensively: if it exposes a
 *      long string field, that is the rendered prompt; if it does not, nothing is pinned and the reason is
 *      reported. No guessing, no fake prompt.
 *
 * Reading an uninjected service throws in Cordis, so every access is wrapped; failure is reported and the
 * plugin keeps working with an empty pinned block.
 */
import { estimateTokens } from '@s1cap/core';
                                                       

                                            
                                                                                                         
                   
                                        
                                                                                                
                             
                                                                                          
                                             
                                 
                                                                               
                    
 

                        
                                            
 

/**
 * Pull one prompt string out of an assembly object.
 *
 * Deliberately narrow: only a direct, long, string-valued own field counts. Section lists, provider objects
 * and anything nested are ignored rather than flattened, because a wrong concatenation would silently
 * corrupt the pinned block — and the pinned block is the cache-stable prefix.
 */
export function readPromptText(assembly         , minChars        )                                              {
  if (assembly === null || typeof assembly !== 'object') return undefined;
  const record = assembly                           ;
  let best                                             ;
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length < minChars) continue;
    if (best === undefined || value.length > best.text.length) best = { text: value, field };
  }
  return best;
}

/**
 * Render the prompt the way the harness does, from the structured assembly.
 *
 * The packaged source (`dsh-system-prompt`) defines it as:
 *
 *   function renderPrompt(assembly) {
 *     return assembly.sections
 *       .map((section) => section.interpolate === false
 *         ? section.text
 *         : interpolate(section, assembly.variables, 'section'))
 *       .filter((text) => text.length > 0)
 *       .join('\n\n');
 *   }
 *
 * One deliberate deviation: the harness *throws* on a malformed or unknown `{{…}}` reference, and a governor
 * may not throw. An unknown reference is therefore left as written and reported once, so the pinned block
 * carries the literal reference instead of a wrong value and the report says which name was missing.
 */
export function renderSections(
  assembly         ,
  onUnknown                         ,
)                                                     {
  if (assembly === null || typeof assembly !== 'object') return undefined;
  const record = assembly                                               ;
  if (!Array.isArray(record.sections)) return undefined;
  const variables = (record.variables ?? {})                           ;
  let interpolated = 0;

  const text = record.sections
    .map((section) => {
      if (section === null || typeof section !== 'object') return '';
      const body = (section                      ).text;
      if (typeof body !== 'string') return '';
      if ((section                             ).interpolate === false) return body;
      return body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (match, name        ) => {
        const value = variables[name];
        if (typeof value !== 'string') {
          onUnknown?.(name);
          return match;
        }
        interpolated += 1;
        return value;
      });
    })
    .filter((body) => body.length > 0)
    .join('\n\n');

  return text === '' ? undefined : { text, interpolated };
}

/**
 * Resolve the prompt once and hand it to the observer.
 *
 * Called lazily by the first pre-step, not during activation: at that point other plugins may not have
 * provided the `systemPrompt` service yet, which is exactly how the pinned block stayed empty for four rounds.
 */
export async function primeSystemPrompt(opts                           )                {
  const report = (line                         )       => {
    if (opts.write !== undefined) opts.write(`${JSON.stringify(line)}\n`);
    else opts.observer.probe(line);
  };
  const minChars = opts.minChars ?? 200;
  try {
    const service = opts.service                            ;
    if (service === null || typeof service !== 'object' || typeof service.assemble !== 'function') {
      report({ schema: 0, kind: 'system-prompt', result: 'no assemble() on the service' });
      return;
    }
    const assembly = await (service.assemble({})                    );

    // Preferred: a direct string field. Fallback: render the structured assembly the way the harness does.
    const direct = readPromptText(assembly, minChars);
    const unknown           = [];
    const rendered =
      direct === undefined ? renderSections(assembly, (name) => unknown.push(name)) : undefined;
    const text = direct?.text ?? rendered?.text;

    if (text === undefined) {
      report({
        schema: 0,
        kind: 'system-prompt',
        result: 'the assembly carries neither a long string field nor renderable sections',
        fields:
          assembly === null || typeof assembly !== 'object'
            ? []
            : Object.keys(assembly          ).slice(0, 24),
      });
      opts.onWarn?.(
        'the system prompt could not be read from systemPrompt.assemble(); the pinned block stays empty',
      );
      return;
    }

    opts.onText(text, estimateTokens(text));
    report({
      schema: 0,
      kind: 'system-prompt',
      result: 'captured',
      source: direct !== undefined ? `string field ${direct.field}` : 'rendered sections',
      chars: text.length,
      ...(rendered !== undefined ? { interpolated: rendered.interpolated } : {}),
      ...(unknown.length > 0 ? { unresolvedVariables: unknown.slice(0, 8) } : {}),
    });
  } catch (err) {
    report({ schema: 0, kind: 'system-prompt', result: 'threw', error: String(err) });
    opts.onWarn?.(`reading the system prompt failed (pinned block stays empty): ${String(err)}`);
  }
}
