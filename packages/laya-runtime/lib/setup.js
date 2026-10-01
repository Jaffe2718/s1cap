/**
 * One-time setup of a Python environment S1CAP owns, so the local backend can run without
 * the user downloading or placing anything by hand.
 *
 *   node --experimental-strip-types packages/laya-runtime/src/setup.ts \
 *     --python <interpreter> --package <distribution> [--dir <venv dir>] [--lock] [--dry-run]
 *
 * The shape of this exists because of three measured facts, not a preference:
 *
 * 1. DSH ships a CPython (3.12.14 at `resources/runtime/primary-runtime/dependencies/python`) with `pip` and
 *    `venv`, but **it is not writable** — an install into it raises `UnauthorizedAccessException`. So the bundled
 *    runtime is a *base* to build from, not a target to install into.
 * 2. That base has neither `laya` nor `torch`, so something has to be installed for the backend to exist at all.
 * 3. `laya-serve` 0.3.21 takes no CLI flags, so the environment has to be complete before the first launch.
 *
 * Therefore: create a venv under S1CAP's own data directory, install into it, and let the settings panel's
 * `pythonPath` point at *that* interpreter. Nothing is written into the host's installation, and the machine
 * stays clean if the user deletes one directory.
 *
 * Two deliberate restraints:
 *
 * - **The distribution name is an argument, not a constant.** `laya` is the import package and the console
 *   script is `laya-serve`, but the *distribution* name on the index is not established, and a guessed name can
 *   install a stranger's project. Passing it explicitly makes the install fail loudly instead of succeeding
 *   wrongly. For the same reason the lock file is written from a real install (`pip freeze`) rather than
 *   hand-written: a requirements list nobody has executed is a wish, and a reproducible one is a record.
 * - **Nothing here runs on plugin load.** Installing packages is not something a plugin does behind a user's
 *   back; this is a command a person runs once, and the plugin only ever *reads* the resulting path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

                               
                                             
                     
                                                                                
                      
                                                                    
                  
                                                 
                
                                
                  
 

export const DEFAULT_VENV_DIR = './.s1cap/laya-venv';

/**
 * The interpreter inside a venv, laid out for the *target* platform.
 *
 * Built from strings rather than `path.join`, because `join` uses the separator of the machine running the code
 * and this path is written to be used on another one: a config file written on Windows and read on Linux would
 * otherwise carry backslashes into a POSIX `execve`.
 */
export function venvPython(venvDir        , platform        )         {
  return platform === 'win32'
    ? `${venvDir}\\Scripts\\python.exe`
    : `${venvDir.replace(/\\/g, '/')}/bin/python`;
}

export function parseSetupArgs(argv          )               {
  const opts               = {
    pythonPath: '',
    packageSpec: '',
    venvDir: DEFAULT_VENV_DIR,
    lock: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--python' && next) {
      opts.pythonPath = next;
      i += 1;
    } else if (arg === '--package' && next) {
      opts.packageSpec = next;
      i += 1;
    } else if (arg === '--dir' && next) {
      opts.venvDir = next;
      i += 1;
    } else if (arg === '--lock') {
      opts.lock = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    }
  }
  return opts;
}

                            
              
                                                         
                                                                                              
                      
                    
 

                                                                             

/**
 * Create the venv, install, and optionally freeze a lock file.
 *
 * `run` is injected so the whole sequence is testable without a Python on the machine: the tests assert the
 * *order* of the commands and the precedence rules (a missing interpreter stops before anything is created,
 * an existing venv is reused rather than clobbered) which are the parts that can silently do the wrong thing.
 */
export function setupLayaEnv(opts              , platform        , run     )            {
  const steps                     = [];
  const push = (what        , ok         , detail        )       => {
    steps.push({ what, ok, detail });
  };

  if (opts.pythonPath === '') {
    push('interpreter', false, 'no --python given: pass the interpreter to build from, e.g. the DSH bundled Python');
    return { ok: false, steps };
  }
  if (opts.packageSpec === '') {
    push('package', false, 'no --package given: the distribution name is not established, and a guessed one can install a stranger\'s project');
    return { ok: false, steps };
  }

  const target = venvPython(opts.venvDir, platform);
  // Reuse, never clobber. A venv holds an installed environment, and recreating it because someone re-ran a
  // setup command would delete a large download to no end.
  const exists = existsSync(target);
  if (opts.dryRun) {
    push('venv', true, exists ? `reuse existing ${target}` : `create ${target}`);
    push('install', true, `${target} -m pip install ${opts.packageSpec}`);
    if (opts.lock) push('lock', true, `write ${join(opts.venvDir, 'requirements.lock.txt')}`);
    return { ok: true, steps, pythonPath: target };
  }

  if (!exists) {
    mkdirSync(dirname(resolve(opts.venvDir)), { recursive: true });
    const made = run(opts.pythonPath, ['-m', 'venv', opts.venvDir]);
    push('create venv', made.ok, made.ok ? target : firstLine(made.out) || 'venv creation failed');
    if (!made.ok) return { ok: false, steps };
  } else {
    push('reuse venv', true, target);
  }

  // `--disable-pip-version-check` keeps pip's own upgrade notice out of the output the user reads, and
  // `--no-input` keeps a missing network from turning into an interactive prompt inside someone else's session.
  const pip = run(target, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', opts.packageSpec]);
  push(`install ${opts.packageSpec}`, pip.ok, pip.ok ? 'ok' : firstLine(pip.out) || 'pip install failed');
  if (!pip.ok) return { ok: false, steps, pythonPath: target };

  let lockPath                    ;
  if (opts.lock) {
    const frozen = run(target, ['-m', 'pip', 'freeze', '--disable-pip-version-check']);
    if (frozen.ok) {
      // The lock is the *installed* set, so it records what actually resolved — including the transitive
      // dependencies nobody wrote down. A hand-written requirements file records an intention instead.
      lockPath = join(opts.venvDir, 'requirements.lock.txt');
      const header = [
        '# Generated by packages/laya-runtime/src/setup.ts from a real install. Do not hand-edit:',
        '# the point is that these versions are the ones that were resolved and run.',
        `# interpreter: ${target}`,
        '',
      ].join('\n');
      writeFileSync(lockPath, header + frozen.out, 'utf8');
      push('lock', true, lockPath);
    } else {
      push('lock', false, firstLine(frozen.out) || 'pip freeze failed');
    }
  }

  return { ok: true, steps, pythonPath: target, ...(lockPath ? { lockPath } : {}) };
}

function firstLine(text        )         {
  return text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
}

/** The real runner: a child process, and its combined output, so failures are readable. */
export function nodeRun()      {
  return (command, args) => {
    const res = spawnSync(command, args, { encoding: 'utf8' });
    return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };
}

function readInstalledVersion(pythonPath        , run     )         {
  const res = run(pythonPath, ['-c', 'import sys; print(sys.version.split()[0])']);
  return res.ok ? res.out.trim() : 'unknown';
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('setup.ts');
if (invokedDirectly) {
  const opts = parseSetupArgs(process.argv.slice(2));
  const run = nodeRun();
  const result = setupLayaEnv(opts, process.platform, run);
  for (const step of result.steps) {
    console.log(`${step.ok ? 'ok  ' : 'FAIL'} ${step.what}${step.detail === '' ? '' : ` - ${step.detail}`}`);
  }
  if (result.ok && result.pythonPath && existsSync(result.pythonPath)) {
    console.log('');
    console.log(`interpreter: ${result.pythonPath} (python ${readInstalledVersion(result.pythonPath, run)})`);
    console.log(`put that path in the settings panel's Laya interpreter field, or laya.pythonPath in the profile`);
  }
  if (result.lockPath && existsSync(result.lockPath)) {
    console.log(`lock: ${result.lockPath}`);
    console.log(`later installs: ${result.pythonPath} -m pip install -r ${result.lockPath}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

// A re-export so the file's own test can read the fixture it writes without importing the CLI side effects.
export const __readFileSync = readFileSync;
