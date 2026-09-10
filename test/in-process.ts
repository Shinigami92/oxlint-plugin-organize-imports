import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServiceCache, organizeFile, resolveSettings } from '../src/core';
import type { Edit, GetService, RuleOptions } from '../src/types';

/**
 * The counterpart to `harness.ts`: it drives `src/` directly instead of spawning oxlint.
 *
 * `noResolve` means the language service never reads anything but the file under test, so a
 * case needs no directory on disk at all — a few milliseconds each, against ~300 ms per CLI
 * spawn. The two layers are complementary: only the CLI suite proves the *published* plugin
 * works and covers the fix/suggestion tiering, which exists only at the oxlint layer.
 */
const VIRTUAL_DIR = path.join(os.tmpdir(), 'oxlint-organize-virtual');

export interface OrganizeSetup {
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
  /** Reuse a cache across calls, to exercise or assert the per-tsconfig service reuse. */
  getService?: GetService;
}

function resolveFilename(filename: string): string {
  return path.isAbsolute(filename) ? filename : path.join(VIRTUAL_DIR, filename);
}

/** Run the language service over `text` and return the collapsed edit, or `null`. */
export function organize(text: string, setup: OrganizeSetup = {}): Edit | null {
  const { filename = 'file.ts', options = {}, tsconfigPath = null, getService } = setup;

  return organizeFile(
    getService ?? createServiceCache(),
    tsconfigPath,
    resolveFilename(filename),
    text,
    resolveSettings(options, text)
  );
}

/** {@link organize}, with the edit applied — the text a `--fix` run would leave behind. */
export function organizeText(text: string, setup: OrganizeSetup = {}): string {
  const edit = organize(text, setup);
  if (edit === null) {
    return text;
  }

  return text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
}

export interface VirtualProject {
  /** Absolute path to the temporary project. */
  dir: string;
  tsconfigPath: string;
  organize: (text: string, setup?: OrganizeSetup) => Edit | null;
  organizeText: (text: string, setup?: OrganizeSetup) => string;
  dispose: () => void;
}

/**
 * A temporary directory holding nothing but a `tsconfig.json`, for the cases that need real
 * compiler options — `jsx` above all, since it decides whether `React` counts as used.
 */
export function createTsconfigProject(
  compilerOptions: Record<string, unknown> = {}
): VirtualProject {
  // `os.tmpdir()` is a symlink on macOS; resolve it so the paths the plugin sees match the
  // paths we write, as `harness.ts` does for the same reason.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oxlint-organize-unit-'));
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions }, null, 2));

  const getService = createServiceCache();

  function defaults(setup: OrganizeSetup): OrganizeSetup {
    return {
      getService,
      tsconfigPath,
      ...setup,
      filename: path.join(dir, setup.filename ?? 'file.ts'),
    };
  }

  return {
    dir,
    tsconfigPath,
    organize: (text, setup = {}) => organize(text, defaults(setup)),
    organizeText: (text, setup = {}) => organizeText(text, defaults(setup)),
    dispose(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
