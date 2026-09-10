import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const PLUGIN_ENTRY = path.join(repoRoot, 'src', 'index.js');
const OXLINT_BIN = path.join(repoRoot, 'node_modules', '.bin', 'oxlint');

export const RULE_ID = 'organize-imports/organize-imports';

const DEFAULT_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'bundler',
  strict: true,
};

/**
 * @typedef {object} Project
 * @property {string} dir Absolute path to the temporary project.
 * @property {(...args: string[]) => { status: number, stdout: string, stderr: string }} lint
 * @property {(...args: string[]) => Diagnostic[]} diagnostics Diagnostics for this plugin's rule only.
 * @property {(...args: string[]) => Diagnostic} onlyDiagnostic The single expected diagnostic.
 * @property {(name: string) => string} read
 * @property {() => void} dispose
 *
 * @typedef {object} Diagnostic Flattened form of oxlint's JSON diagnostic.
 * @property {string} message
 * @property {string} code
 * @property {number} offset
 * @property {number} length
 *
 * @typedef {object} RawDiagnostic
 * @property {string} message
 * @property {string} code
 * @property {{ span: { offset: number, length: number } }[]} labels
 */

/**
 * Create a throwaway project on disk and run the real `oxlint` binary against it.
 *
 * Everything here goes through the actual CLI rather than calling the rule directly: the
 * point of the suite is to prove the plugin works as oxlint loads and applies it, including
 * the fix/suggestion tiering, which only exists at the CLI layer.
 *
 * @param {object} setup
 * @param {Record<string, string>} setup.files Paths relative to the project root, mapped to contents.
 * @param {Record<string, unknown>} [setup.compilerOptions] Merged over the defaults.
 * @param {Record<string, unknown>} [setup.ruleOptions] Rule options, if any.
 * @returns {Project}
 */
export function createProject({ files, compilerOptions, ruleOptions }) {
  // `os.tmpdir()` is a symlink on macOS. Resolve it so the paths the plugin sees match the
  // paths we write, which matters for tsconfig discovery.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oxlint-organize-'));

  /**
   * @param {string} name
   * @param {string} contents
   */
  function write(name, contents) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  write(
    'package.json',
    JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2),
  );
  write(
    'tsconfig.json',
    JSON.stringify(
      { compilerOptions: { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions } },
      null,
      2,
    ),
  );
  write(
    '.oxlintrc.json',
    JSON.stringify(
      {
        jsPlugins: [PLUGIN_ENTRY],
        rules: { [RULE_ID]: ruleOptions ? ['error', ruleOptions] : 'error' },
      },
      null,
      2,
    ),
  );

  for (const [name, contents] of Object.entries(files)) write(name, contents);

  /** @type {Project['lint']} */
  function lint(...args) {
    const result = spawnSync(
      OXLINT_BIN,
      // Silence every built-in rule, so assertions only ever see this plugin.
      ['-A', 'all', '-D', RULE_ID, ...args],
      { cwd: dir, encoding: 'utf8' },
    );

    if (result.error) throw result.error;
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  return {
    dir,
    lint,
    diagnostics(...args) {
      const { stdout, stderr } = lint('-f', 'json', ...args);
      /** @type {{ diagnostics: RawDiagnostic[] }} */
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`oxlint did not emit JSON.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
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
    },
    onlyDiagnostic(...args) {
      const found = this.diagnostics(...args);
      const [first] = found;
      if (found.length !== 1 || first === undefined) {
        throw new Error(`Expected exactly one diagnostic, got ${found.length}.`);
      }

      return first;
    },
    read(name) {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    },
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
