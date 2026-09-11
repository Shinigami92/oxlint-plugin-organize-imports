import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { organizeFile, resolveSettings } from '../src/core';
import type { Backend, Edit, RuleOptions } from '../src/types';
import type { TestBackend } from './backends';

/**
 * The counterpart to `harness.ts`: it drives `src/` directly instead of spawning oxlint.
 *
 * Neither backend reads anything but the file under test (the language service runs
 * `noResolve`, the language server is handed the text over `didOpen`), so a case needs no
 * directory on disk at all — a few milliseconds each, against ~300 ms per CLI spawn. The two
 * layers are complementary: only the CLI suite proves the *published* plugin works and covers
 * the fix/suggestion tiering, which exists only at the oxlint layer.
 */
const VIRTUAL_DIR = path.join(os.tmpdir(), 'oxlint-organize-virtual');

export interface OrganizeSetup {
  backend: Backend;
  /**
   * Absolute, or relative to a virtual directory that is never created. The extension
   * decides the script kind, so `.tsx` matters and the rest of the path does not.
   *
   * @default 'file.ts'
   */
  filename?: string;
  options?: RuleOptions;
  /** Passed straight through; `null` selects the no-tsconfig compiler defaults. */
  tsconfigPath?: string | null;
}

function resolveFilename(filename: string): string {
  return path.isAbsolute(filename) ? filename : path.join(VIRTUAL_DIR, filename);
}

/** Run the backend over `text` and return the collapsed edit, or `null`. */
export function organize(text: string, setup: OrganizeSetup): Edit | null {
  const { backend, filename = 'file.ts', options = {}, tsconfigPath = null } = setup;

  return organizeFile(
    backend,
    tsconfigPath,
    resolveFilename(filename),
    text,
    resolveSettings(options, text)
  );
}

/** {@link organize}, with the edit applied — the text a `--fix` run would leave behind. */
export function organizeText(text: string, setup: OrganizeSetup): string {
  const edit = organize(text, setup);
  if (edit === null) {
    return text;
  }

  return text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
}

type ProjectSetup = Omit<OrganizeSetup, 'backend'>;

export interface VirtualProject {
  /** Absolute path to the temporary project. */
  dir: string;
  tsconfigPath: string;
  backend: Backend;
  organize: (text: string, setup?: ProjectSetup) => Edit | null;
  organizeText: (text: string, setup?: ProjectSetup) => string;
  dispose: () => void;
}

/**
 * A temporary directory holding a `tsconfig.json`, for the cases that need real compiler
 * options — `jsx` above all, since it decides whether `React` counts as used.
 *
 * Each project gets a backend of its own, started inside the directory. The language server
 * decides which project a file belongs to from what is on disk, so the file is written out
 * before every call; the language service reads the text it is handed and does not care.
 */
export function createTsconfigProject(
  testBackend: TestBackend,
  compilerOptions: Record<string, unknown> = {}
): VirtualProject {
  // `os.tmpdir()` is a symlink on macOS; resolve it so the paths the plugin sees match the
  // paths we write, as `harness.ts` does for the same reason.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oxlint-organize-unit-'));
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions }, null, 2));

  const backend = testBackend.create({ cwd: dir });

  function defaults(text: string, setup: ProjectSetup): OrganizeSetup {
    const filename = path.join(dir, setup.filename ?? 'file.ts');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text);

    return { backend, tsconfigPath, ...setup, filename };
  }

  return {
    dir,
    tsconfigPath,
    backend,
    organize: (text, setup = {}) => organize(text, defaults(text, setup)),
    organizeText: (text, setup = {}) => organizeText(text, defaults(text, setup)),
    dispose(): void {
      backend.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
