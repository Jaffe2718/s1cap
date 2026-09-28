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
  /** direct report channel: proves the primer ran even when the observer path is in question */
  write?(line: string): void;
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
  assembly: unknown,
  onUnknown?: (name: string) => void,
): { text: string; interpolated: number } | undefined {
  if (assembly === null || typeof assembly !== 'object') return undefined;
  const record = assembly as { sections?: unknown; variables?: unknown };
  if (!Array.isArray(record.sections)) return undefined;
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let interpolated = 0;

  const text = record.sections
    .map((section) => {
      if (section === null || typeof section !== 'object') return '';
      const body = (section as { text?: unknown }).text;
      if (typeof body !== 'string') return '';
      if ((section as { interpolate?: unknown }).interpolate === false) return body;
      return body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (match, name: string) => {
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
export async function primeSystemPrompt(opts: SystemPromptSourceOptions): Promise<void> {
  const report = (line: Record<string, unknown>): void => {
    if (opts.write !== undefined) opts.write(`${JSON.stringify(line)}\n`);
    else opts.observer.probe(line);
  };
  const minChars = opts.minChars ?? 200;
  try {
    const service = opts.service as AssemblyLike | undefined;
    if (service === null || typeof service !== 'object' || typeof service.assemble !== 'function') {
      report({ schema: 0, kind: 'system-prompt', result: 'no assemble() on the service' });
      return;
    }
    const assembly = await (service.assemble({}) as Promise<unknown>);

    // Preferred: a direct string field. Fallback: render the structured assembly the way the harness does.
    const direct = readPromptText(assembly, minChars);
    const unknown: string[] = [];
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
            : Object.keys(assembly as object).slice(0, 24),
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
