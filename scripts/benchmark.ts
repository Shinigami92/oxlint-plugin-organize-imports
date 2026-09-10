/**
 * Benchmark the plugin against a real repository and print a paste-ready section for
 * `BENCHMARKS.md`.
 *
 * Usage:
 *   pnpm run benchmark -- <path-to-target-repo> [--runs 3] [--mangle] [--force]
 *
 * `--mangle` scrambles each file's imports first. On an already-organized repository the
 * equivalence check has nothing to compare, so that flag is what gives it teeth.
 *
 * Benchmarks are serialised through an exclusive lock file: a second run refuses to start
 * while another is in flight, because two sweeps competing for CPU produce numbers that
 * mean nothing. `--force` breaks a lock left behind by a crashed run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServiceCache, organizeFile, resolveSettings } from '../src/core';
import { isOrganizable } from '../src/eligibility';
import type { Mode } from '../src/types';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const LOCK_PATH = path.join(os.tmpdir(), 'oxlint-plugin-organize-imports.benchmark.lock');

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.local',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
]);

const TS_FILE = /\.(?:m|c)?tsx?$/u;

/** Enough to pay for lazily-created TypeScript state without re-sweeping the repo. */
const WARMUP_FILES = 25;

/** Binding injected by `--mangle`; never referenced, so every mode must drop it. */
const PROBE_BINDING = '__organizeImportsBenchmarkUnused__';

function scriptKindFor(filename: string): ts.ScriptKind {
  return filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Scramble a file's import block so the sweep actually has work to do.
 *
 * A repository that is already organized makes the whole comparison vacuous: both variants
 * return "no change" for every file, and "0 files with differing output" is then 0 nulls
 * compared to 0 nulls. Reversing the leading imports exercises sorting, and injecting an
 * unreferenced binding from an existing specifier exercises unused-import removal — which is
 * the specific thing `noResolve` could plausibly break.
 *
 * @returns The mangled text, or `null` if the file has no imports to scramble.
 */
function mangle(text: string, filename: string): string | null {
  const sourceFile = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filename)
  );

  const leading: ts.ImportDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      leading.push(statement);
    } else if (leading.length > 0) {
      break;
    }
  }

  const first = leading[0];
  const last = leading.at(-1);
  if (first === undefined || last === undefined || !ts.isStringLiteral(first.moduleSpecifier)) {
    return null;
  }

  const start = first.getStart(sourceFile);
  const end = last.getEnd();
  const declarations = leading.map((declaration) =>
    text.slice(declaration.getStart(sourceFile), declaration.getEnd())
  );
  const probe = `import { ${PROBE_BINDING} } from '${first.moduleSpecifier.text}';`;

  return text.slice(0, start) + [probe, ...declarations.toReversed()].join('\n') + text.slice(end);
}

interface Variant {
  readonly label: string;
  readonly overrides: ts.CompilerOptions;
}

/** The shipped configuration, versus the same thing with the perf overrides removed. */
const VARIANTS: Variant[] = [
  { label: 'noResolve (shipped)', overrides: { noResolve: true } },
  { label: 'module resolution on', overrides: {} },
];

const MODES: Mode[] = ['All', 'SortAndCombine'];

interface GitInfo {
  readonly commit: string;
  readonly shortCommit: string;
  readonly dirty: boolean;
}

function gitInfo(cwd: string): GitInfo {
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  return {
    commit: run('rev-parse', 'HEAD'),
    shortCommit: run('rev-parse', '--short', 'HEAD'),
    dirty: run('status', '--porcelain').length > 0,
  };
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (TS_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }

  return out;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

interface Measurement {
  readonly medianMs: number;
  readonly msPerFile: number;
  readonly changed: number;
  /** Organized output per file, for cross-variant comparison. */
  readonly outputs: Map<string, string | null>;
}

function measure(
  files: ReadonlyArray<string>,
  texts: ReadonlyMap<string, string>,
  tsconfigPath: string | null,
  overrides: ts.CompilerOptions,
  mode: Mode,
  runs: number
): Measurement {
  const durations: number[] = [];
  let outputs = new Map<string, string | null>();

  const sweep = (subject: ReadonlyArray<string>): Map<string, string | null> => {
    const getService = createServiceCache(overrides);
    const pass = new Map<string, string | null>();
    for (const file of subject) {
      const text = texts.get(file) ?? '';
      const edit = organizeFile(
        getService,
        tsconfigPath,
        file,
        text,
        resolveSettings({ mode }, text)
      );
      pass.set(file, edit === null ? null : edit.replacement);
    }

    return pass;
  };

  // Warm up on a handful of files, not the whole repo: the point is to pay for lazily-created
  // TypeScript state once, and on a large sweep that cost is already noise.
  sweep(files.slice(0, WARMUP_FILES));

  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    const pass = sweep(files);
    durations.push(performance.now() - started);
    outputs = pass;
  }

  const medianMs = median(durations);

  return {
    medianMs,
    msPerFile: medianMs / files.length,
    changed: [...outputs.values()].filter((value) => value !== null).length,
    outputs,
  };
}

function dirtySuffix(git: GitInfo): string {
  return git.dirty ? ' (dirty tree)' : '';
}

/** How many files the two variants organized differently. */
function countDiffering(
  left: ReadonlyMap<string, string | null>,
  right: ReadonlyMap<string, string | null>
): number {
  let differing = 0;
  for (const [file, value] of right) {
    if (left.get(file) !== value) {
      differing++;
    }
  }

  return differing;
}

function packageVersion(name: string): string {
  const manifest = path.join(repoRoot, 'node_modules', name, 'package.json');
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string };

  return parsed.version;
}

function acquireLock(force: boolean): () => void {
  if (force && fs.existsSync(LOCK_PATH)) {
    fs.rmSync(LOCK_PATH, { force: true });
  }

  let handle: number;
  try {
    handle = fs.openSync(LOCK_PATH, 'wx');
  } catch {
    const held = fs.readFileSync(LOCK_PATH, 'utf8');
    throw new Error(
      `Another benchmark is already running, so these numbers would be meaningless.\n` +
        `Lock: ${LOCK_PATH}\n${held}\n` +
        `If that run crashed, re-run with --force.`
    );
  }

  fs.writeFileSync(handle, `pid ${process.pid}\nstarted ${new Date().toISOString()}\n`);
  fs.closeSync(handle);

  return () => {
    fs.rmSync(LOCK_PATH, { force: true });
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const shouldMangle = argv.includes('--mangle');
  const runsFlag = argv.indexOf('--runs');
  const runs = runsFlag === -1 ? 3 : Number(argv[runsFlag + 1] ?? 3);
  const target = argv.find((arg) => !arg.startsWith('--') && arg !== String(runs));

  if (target === undefined) {
    throw new Error('Usage: pnpm run benchmark -- <path-to-target-repo> [--runs 3] [--force]');
  }

  const targetRoot = path.resolve(target);
  if (!fs.existsSync(targetRoot)) {
    throw new Error(`No such directory: ${targetRoot}`);
  }

  const release = acquireLock(force);
  try {
    // Mirror exactly what the rule would look at, so "files changed" means what it says.
    const texts = new Map<string, string>();
    const files: string[] = [];
    for (const file of collectFiles(targetRoot)) {
      const text = fs.readFileSync(file, 'utf8');
      if (!isOrganizable(file, text)) {
        continue;
      }

      const subject = shouldMangle ? mangle(text, file) : text;
      if (subject === null) {
        continue;
      }

      texts.set(file, subject);
      files.push(file);
    }
    const tsconfigPath = ts.findConfigFile(targetRoot, ts.sys.fileExists) ?? null;

    const targetGit = gitInfo(targetRoot);
    const pluginGit = gitInfo(repoRoot);
    const cpu = os.cpus()[0]?.model ?? 'unknown';

    console.error(
      `Benchmarking ${path.basename(targetRoot)}: ${files.length} files, ${runs} runs each.`
    );

    const rows: string[] = [];
    const comparisons: string[] = [];

    for (const mode of MODES) {
      const perVariant = new Map<string, Measurement>();

      for (const variant of VARIANTS) {
        console.error(`  ${mode} / ${variant.label} ...`);
        const result = measure(files, texts, tsconfigPath, variant.overrides, mode, runs);
        perVariant.set(variant.label, result);
        rows.push(
          `| ${mode} | ${variant.label} | ${(result.medianMs / 1000).toFixed(1)} s | ${result.msPerFile.toFixed(2)} ms | ${result.changed} |`
        );
      }

      const shipped = perVariant.get('noResolve (shipped)');
      const resolved = perVariant.get('module resolution on');
      if (shipped !== undefined && resolved !== undefined) {
        const differing = countDiffering(shipped.outputs, resolved.outputs);
        const speedup = `**${(resolved.medianMs / shipped.medianMs).toFixed(1)}x** faster`;

        comparisons.push(
          shipped.changed === 0
            ? `- \`${mode}\`: ${speedup}. **Equivalence not tested**: no file needed organizing, so the comparison was empty. Re-run with \`--mangle\`.`
            : `- \`${mode}\`: ${speedup}, **${differing}** of ${shipped.changed} organized files with differing output.`
        );
      }
    }

    const today = new Date().toISOString().slice(0, 10);

    console.log(`
### ${path.basename(targetRoot)} — ${today}

| Field | Value |
| ----- | ----- |
| Target repo | \`${path.basename(targetRoot)}\` @ \`${targetGit.shortCommit}\`${dirtySuffix(targetGit)} |
| Target commit | \`${targetGit.commit}\` |
| Plugin commit | \`${pluginGit.commit}\`${dirtySuffix(pluginGit)} |
| TypeScript | ${packageVersion('typescript')} |
| oxlint | ${packageVersion('oxlint')} |
| Node.js | ${process.version} |
| Platform | ${process.platform}/${process.arch}, ${cpu} |
| TS files swept | ${files.length} |
| Corpus | ${shouldMangle ? 'imports reversed + one unused import injected (`--mangle`)' : 'as committed'} |
| Runs (median, after 1 warmup) | ${runs} |

| Mode | Variant | Total | Per file | Files changed |
| ---- | ------- | ----- | -------- | ------------- |
${rows.join('\n')}

${comparisons.join('\n')}
`);
  } finally {
    release();
  }
}

main();
