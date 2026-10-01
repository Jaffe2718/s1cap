#!/usr/bin/env node
/**
 * Open one test round: a randomly named directory inside the workspace, and nothing else.
 *
 * **No round runs the fixture any more, so it needs no round directory.** `scripts/round-tasks.json` is not part of
 * a round (see `docs/CELLS-RUN.md`, "Messages"): measurement draws a long-horizon task, and what validates the
 * environment is the harness's `PROBE` pre-flight instance. The fixture itself also writes nothing - its turns ask
 * for the answer in the conversation and forbid creating, modifying or deleting a file or directory - so it contains
 * no `{salt}` placeholder either. Behaviour is unchanged: `--create` still opens the directory, `{salt}` is still
 * substituted where a fixture contains it (nowhere, today), and the messages are printed as recorded - the closing
 * summary still describes the directory, which is what a writing stimulus uses.
 *
 * Why the mechanism exists. Test rounds used to write their answer to the workspace root, under a name the task
 * itself suggested - `pelican-bicycle.html` - so a later round could read the previous round's answer instead of
 * solving the task, and two rounds writing the same name would silently replace one another. A run that measures
 * the file system is not a measurement of the method.
 *
 * The workspace is deliberately **not** reconfigured. A session's workspace is the instance's working
 * directory and the sandbox confines writes to it, so narrowing it per round would work - but it changes the
 * environment the experiment runs in, and the session's workspace is part of what is being observed. For a
 * stimulus that writes, the isolation unit is therefore a directory *inside* the workspace, named by a random
 * salt:
 *
 *   <workspace>/<salt>/<answer>.html
 *
 * A salt rather than a timestamp, because a name that can be computed (or read off the previous round's
 * prompt) is a name that can be guessed, listed and opened. A fresh 48-bit salt names a directory no other
 * round's task text contains.
 *
 * What this does and does not buy, stated plainly: it removes the collision and the shared-name inheritance.
 * The workspace still *contains* the other rounds, so an agent that lists the workspace root can still find
 * them; the defence against that is that the task text names one directory, and the harness moves a finished
 * round's directory out of the workspace once its evidence has been collected.
 *
 * The round's messages come from `scripts/round-tasks.json` and are sent as recorded rather than retyped, because
 * a stimulus that is retyped is a stimulus that has changed. Where a stimulus names a directory, the salt is
 * substituted into it here rather than typed by hand: a mistyped salt would send the answer somewhere the round is
 * not watching. The fixture is ASCII-escaped (`\uXXXX`) because the experiment's stimuli are Chinese and no
 * repository file may contain Chinese; decoding it yields the exact code points that were recorded.
 *
 * Usage:
 *   node scripts/new-test-run.mjs                 # print this round's directory and its messages
 *   node scripts/new-test-run.mjs --create        # also create it
 *   node scripts/new-test-run.mjs --root <dir>    # workspace to open the round in (default: the repo's parent)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_ROOT = dirname(REPO);
const TASKS = join(HERE, 'round-tasks.json');

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

/** 48 bits of urandom, lowercase hex: a name that is unique per round and cannot be derived from the last one. */
function salt() {
  return randomBytes(6).toString('hex');
}

const root = resolve(readFlag('--root', DEFAULT_ROOT));
const created = process.argv.includes('--create');
const name = salt();
const dir = join(root, name);

if (created) {
  // The root may not exist yet, so it is created recursively. The salt directory is not: `recursive: false`
  // means a name collision fails loudly instead of silently sharing a directory with another round, and 48
  // random bits make the odds of ever seeing that failure a rounding error.
  mkdirSync(root, { recursive: true });
  mkdirSync(dir);
}

// One round is one conversation: the messages below are sent in order, into the same session, and the salt
// appears exactly once - in the first one, which is what gives the round its directory.
const turns = JSON.parse(readFileSync(TASKS, 'utf8')).turns.map((turn) => ({
  turn: turn.turn,
  text: String(turn.text).replaceAll('{salt}', name),
}));

process.stdout.write(
  [
    `workspace       : ${root}`,
    `round directory : ${dir}`,
    `state           : ${created ? 'created' : 'not created (pass --create)'}`,
    '',
    'messages to send, in this order, into one session:',
    ...turns.map((t) => `  ${t.turn}. ${t.text}`),
    '',
    `every turn writes inside "${name}/"; the round directory then holds that round's answer and nothing else,`,
    'and no two rounds share a name.',
  ].join('\n') + '\n',
);
