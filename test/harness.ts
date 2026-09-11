import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const PLUGIN_ENTRY = path.join(repoRoot, 'dist', 'index.js');
// The package's own entry, not the `node_modules/.bin` shim: on Windows that shim is a
// `.CMD` file, which `spawnSync` refuses to execute without a shell. The entry is a plain
// Node script, so running it with the current Node binary behaves the same everywhere.
const OXLINT_ENTRY = path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');

export const RULE_ID = 'organize-imports/organize-imports';

/**
 * Far above a real run (~150-500 ms), far below vitest's 30 s `testTimeout`, and small enough
 * that even every case hanging keeps the file under CI's 10-minute job limit — otherwise the
 * failures would be cancelled away before the reporter ever printed them.
 */
const SPAWN_TIMEOUT_MS = 10_000;

const DEFAULT_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'bundler',
  strict: true,
};

/** Flattened form of oxlint's JSON diagnostic. */
export interface Diagnostic {
  message: string;
  code: string;
  offset: number;
  length: number;
}

interface RawDiagnostic {
  message: string;
  code: string;
  labels: Array<{ span: { offset: number; length: number } }>;
}

export interface LintResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Project {
  /** Absolute path to the temporary project. */
  dir: string;
  lint: (...args: string[]) => LintResult;
  /** Diagnostics for this plugin's rule only. */
  diagnostics: (...args: string[]) => Diagnostic[];
  /** The single expected diagnostic. */
  onlyDiagnostic: (...args: string[]) => Diagnostic;
  read: (name: string) => string;
  dispose: () => void;
}

export interface ProjectSetup {
  /** Paths relative to the project root, mapped to contents. */
  files: Record<string, string>;
  /** Merged over the defaults. */
  compilerOptions?: Record<string, unknown>;
  ruleOptions?: Record<string, unknown>;
}

/**
 * Create a throwaway project on disk and run the real `oxlint` binary against it.
 *
 * Everything here goes through the actual CLI rather than calling the rule directly: the
 * point of the suite is to prove the plugin works as oxlint loads and applies it, including
 * the fix/suggestion tiering, which only exists at the CLI layer. It loads the *built*
 * `dist/index.js`, so the suite also covers the published artifact.
 */
export function createProject({ files, compilerOptions, ruleOptions }: ProjectSetup): Project {
  if (!fs.existsSync(PLUGIN_ENTRY)) {
    throw new Error(`Missing ${PLUGIN_ENTRY}. Run \`pnpm run build\` before the tests.`);
  }

  // `os.tmpdir()` is a symlink on macOS. Resolve it so the paths the plugin sees match the
  // paths we write, which matters for tsconfig discovery.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oxlint-organize-'));

  function write(name: string, contents: string): void {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  write(
    'package.json',
    JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2)
  );
  write(
    'tsconfig.json',
    JSON.stringify(
      { compilerOptions: { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions } },
      null,
      2
    )
  );
  write(
    '.oxlintrc.json',
    JSON.stringify(
      {
        jsPlugins: [PLUGIN_ENTRY],
        rules: { [RULE_ID]: ruleOptions ? ['error', ruleOptions] : 'error' },
      },
      null,
      2
    )
  );

  for (const [name, contents] of Object.entries(files)) {
    write(name, contents);
  }

  function lint(...args: string[]): LintResult {
    const result = spawnSync(
      process.execPath,
      // Silence every built-in rule, so assertions only ever see this plugin.
      [OXLINT_ENTRY, '-A', 'all', '-D', RULE_ID, ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        // A synchronous spawn cannot be interrupted by vitest's own timeout, so a hung oxlint
        // would otherwise stall the whole run until CI kills the job. Fail the case instead,
        // with whatever the plugin managed to say: the trace flag makes the language-server
        // bridge narrate itself to stderr, which only ever shows up in this error.
        timeout: SPAWN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          OXLINT_PLUGIN_ORGANIZE_IMPORTS_TRACE: '1',
          // Well inside the spawn timeout, so a stalled server is reported by the plugin — and
          // the worker's error/exit events get a turn of the event loop to be traced — before
          // the process is killed.
          OXLINT_PLUGIN_ORGANIZE_IMPORTS_TIMEOUT_MS: '3000',
        },
      }
    );

    if (result.error) {
      throw new Error(
        `oxlint ${result.error.message} after ${SPAWN_TIMEOUT_MS} ms.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        { cause: result.error }
      );
    }

    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function diagnostics(...args: string[]): Diagnostic[] {
    const { stdout, stderr } = lint('-f', 'json', ...args);

    let parsed: { diagnostics: RawDiagnostic[] };
    try {
      parsed = JSON.parse(stdout) as { diagnostics: RawDiagnostic[] };
    } catch {
      throw new Error(`oxlint did not emit JSON.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    // A diagnostic without a code is oxlint reporting that a plugin threw. Its message is the
    // plugin's error, and stderr holds the bridge trace; both are what a failure needs to show.
    const crashed = parsed.diagnostics.filter((diagnostic) => typeof diagnostic.code !== 'string');
    if (crashed.length > 0) {
      throw new Error(
        `The plugin threw inside oxlint:\n${crashed.map((diagnostic) => diagnostic.message).join('\n')}\nstderr:\n${stderr}`
      );
    }

    return parsed.diagnostics
      .filter((diagnostic) => diagnostic.code.startsWith('organize-imports'))
      .map((diagnostic) => {
        const span = diagnostic.labels[0]?.span;

        return {
          message: diagnostic.message,
          code: diagnostic.code,
          offset: span?.offset ?? -1,
          length: span?.length ?? -1,
        };
      });
  }

  return {
    dir,
    lint,
    diagnostics,
    onlyDiagnostic(...args: string[]): Diagnostic {
      const found = diagnostics(...args);
      const [first] = found;
      if (found.length !== 1 || first === undefined) {
        throw new Error(`Expected exactly one diagnostic, got ${found.length}.`);
      }

      return first;
    },
    read(name: string): string {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    },
    dispose(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
