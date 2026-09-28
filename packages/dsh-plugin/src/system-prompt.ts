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
import type { StepObserver } from './step-observer.ts';

export interface SystemPromptSourceOptions {
  /** the service, as returned by `ctx.get('systemPrompt')`, or undefined when the context offers none */
  service: unknown;
  observer: Pick<StepObserver, 'probe'>;
  /** called with the text once (and whenever it changes); never throws into the caller */
  onText(text: string, tokens: number): void;
  onWarn?(message: string): void;
  /** minimum length for a string field to be considered the rendered prompt */
  minChars?: number;
}

interface AssemblyLike {
  assemble?: (context?: unknown) => unknown;
}

/**
 * Pull one prompt string out of an assembly object.
 *
 * Deliberately narrow: only a direct, long, string-valued own field counts. Section lists, provider objects
 * and anything nested are ignored rather than flattened, because a wrong concatenation would silently
 * corrupt the pinned block — and the pinned block is the cache-stable prefix.
 */
export function readPromptText(assembly: unknown, minChars: number): { text: string; field: string } | undefined {
  if (assembly === null || typeof assembly !== 'object') return undefined;
  const record = assembly as Record<string, unknown>;
  let best: { text: string; field: string } | undefined;
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length < minChars) continue;
    if (best === undefined || value.length > best.text.length) best = { text: value, field };
  }
  return best;
}

/**
 * Resolve the prompt once and hand it to the observer. Fire-and-forget by design: the first LLM call may
 * still run with an empty pinned block, and every later one benefits.
 */
export async function primeSystemPrompt(opts: SystemPromptSourceOptions): Promise<void> {
  const minChars = opts.minChars ?? 200;
  try {
    const service = opts.service as AssemblyLike | undefined;
    if (service === null || typeof service !== 'object' || typeof service.assemble !== 'function') {
      opts.observer.probe({ schema: 0, kind: 'system-prompt', result: 'no assemble() on the service' });
      return;
    }
    const assembly = await (service.assemble({}) as Promise<unknown>);
    const found = readPromptText(assembly, minChars);
    if (found === undefined) {
      opts.observer.probe({
        schema: 0,
        kind: 'system-prompt',
        result: 'assembly carries no long string field',
        fields:
          assembly === null || typeof assembly !== 'object'
            ? []
            : Object.keys(assembly as object).slice(0, 24),
      });
      opts.onWarn?.(
        'the system prompt could not be read from systemPrompt.assemble(); the pinned block stays empty ' +
          '(render with the package\'s exported renderPrompt once its assembly shape is confirmed)',
      );
      return;
    }
    opts.onText(found.text, estimateTokens(found.text));
    opts.observer.probe({
      schema: 0,
      kind: 'system-prompt',
      result: 'captured',
      field: found.field,
      chars: found.text.length,
    });
  } catch (err) {
    opts.observer.probe({ schema: 0, kind: 'system-prompt', result: 'threw', error: String(err) });
    opts.onWarn?.(`reading the system prompt failed (pinned block stays empty): ${String(err)}`);
  }
}
