import path from 'node:path';
import ts from 'typescript';
import { assertLanguageServiceAvailable } from './typescript-support.js';

/**
 * @typedef {'All' | 'SortAndCombine' | 'RemoveUnused'} Mode
 *
 * @typedef {object} Settings
 * @property {Mode} mode
 * @property {boolean} destructive Whether the mode can remove imports, and so change behaviour.
 * @property {ts.FormatCodeSettings} formatOptions
 * @property {ts.UserPreferences} preferences
 *
 * @typedef {object} ServiceEntry
 * @property {ts.LanguageService} service
 * @property {{ file: string, text: string, version: number, cwd: string }} state
 *
 * @typedef {(tsconfigPath?: string | null) => ServiceEntry} GetService
 *
 * @typedef {object} Edit
 * @property {number} start
 * @property {number} end
 * @property {string} replacement
 */

/**
 * One `LanguageService` per tsconfig, reused for every file in the run.
 *
 * The host only ever reports the *current* file as a root, so TypeScript builds a
 * single-file program: `organizeImports` needs the binder and the local checker, not a
 * project-wide type graph. This is the same trick `prettier-plugin-organize-imports` and
 * `organize-imports-cli` use, and it is what keeps the plugin fast enough to run per-file
 * inside a linter.
 *
 * @returns {GetService}
 */
export function createServiceCache() {
  assertLanguageServiceAvailable();

  /** @type {Map<string, ServiceEntry>} */
  const services = new Map();
  /** @type {Map<string, ts.CompilerOptions>} */
  const compilerOptions = new Map();

  /**
   * @param {string | null | undefined} tsconfigPath
   * @returns {ts.CompilerOptions}
   */
  function getCompilerOptions(tsconfigPath) {
    if (!tsconfigPath) return { allowJs: true, allowNonTsExtensions: true };

    const cached = compilerOptions.get(tsconfigPath);
    if (cached) return cached;

    const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(
      config ?? {},
      ts.sys,
      path.dirname(tsconfigPath),
    );
    compilerOptions.set(tsconfigPath, options);
    return options;
  }

  return function getService(tsconfigPath) {
    const key = tsconfigPath ?? '';
    const cached = services.get(key);
    if (cached) return cached;

    const state = { file: '', text: '', version: 0, cwd: '' };
    const options = getCompilerOptions(tsconfigPath);

    /** @type {ts.LanguageServiceHost} */
    const host = {
      getScriptFileNames: () => [state.file],
      getScriptVersion: () => String(state.version),
      getScriptSnapshot: (fileName) => {
        if (fileName === state.file) {
          return ts.ScriptSnapshot.fromString(state.text);
        }

        const text = ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCompilationSettings: () => options,
      getDefaultLibFileName: ts.getDefaultLibFileName,
      getCurrentDirectory: () => state.cwd,
      getNewLine: () => ts.sys.newLine,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      getDirectories: ts.sys.getDirectories,
      directoryExists: ts.sys.directoryExists,
    };

    /** @type {ServiceEntry} */
    const entry = { service: ts.createLanguageService(host), state };
    services.set(key, entry);
    return entry;
  };
}

/**
 * Apply TypeScript's text changes to `text`, right-to-left so earlier offsets stay valid.
 *
 * @param {string} text
 * @param {readonly ts.TextChange[]} changes
 * @returns {string}
 */
export function applyTextChanges(text, changes) {
  let out = text;
  for (const { span, newText } of changes.toSorted((a, b) => b.span.start - a.span.start)) {
    out = out.slice(0, span.start) + newText + out.slice(span.start + span.length);
  }

  return out;
}

/**
 * Run the language service's `organizeImports` on one file and collapse the result into a
 * single ranged replacement, or `null` if the file is already organized.
 *
 * TypeScript hands back a scattered list of text changes. Reporting them as one range keeps
 * the diagnostic pointed at the import block instead of rewriting the whole file, and keeps
 * the fix from colliding with unrelated rules further down.
 *
 * @param {GetService} getService
 * @param {string | null | undefined} tsconfigPath
 * @param {string} filename Absolute path of the file being linted.
 * @param {string} text
 * @param {Settings} settings
 * @returns {Edit | null}
 */
export function organizeFile(getService, tsconfigPath, filename, text, settings) {
  const { service, state } = getService(tsconfigPath);
  state.file = filename;
  state.text = text;
  state.cwd = path.dirname(filename);
  state.version++;

  const [changes] = service.organizeImports(
    { type: 'file', fileName: filename, mode: ts.OrganizeImportsMode[settings.mode] },
    settings.formatOptions,
    settings.preferences,
  );

  const textChanges = changes?.textChanges ?? [];
  if (textChanges.length === 0) return null;

  const start = Math.min(...textChanges.map((change) => change.span.start));
  const end = Math.max(...textChanges.map((change) => change.span.start + change.span.length));

  const organized = applyTextChanges(text, textChanges);

  // Everything before `start` is untouched, so it lines up in both strings. Everything after
  // `end` is untouched but shifted by the net length change, so the rewritten region ends at
  // `end + delta` in the organized text.
  const delta = organized.length - text.length;
  const replacement = organized.slice(start, end + delta);

  // TypeScript sometimes reports a change that reproduces the original text verbatim.
  if (replacement === text.slice(start, end)) return null;

  return { start, end, replacement };
}

/**
 * Detect the dominant line ending, so the rewritten import block matches the rest of the file
 * instead of whatever the host platform prefers.
 *
 * @param {string} text
 * @returns {'\n' | '\r\n'}
 */
function detectNewLine(text) {
  const index = text.indexOf('\n');
  return index > 0 && text[index - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * @typedef {object} RuleOptions
 * @property {Mode} [mode]
 * @property {number} [tabWidth]
 * @property {boolean} [useTabs]
 *
 * @param {RuleOptions} [options]
 * @param {string} [text] Source text, used to match the file's existing line endings.
 * @returns {Settings}
 */
export function resolveSettings(options = {}, text = '') {
  const mode = options.mode ?? 'All';
  const tabWidth = options.tabWidth ?? 2;
  const newLine = detectNewLine(text);

  return {
    mode,
    // `SortAndCombine` only reorders and merges, which preserves behaviour. The other two
    // modes delete imports, which does not.
    destructive: mode !== 'SortAndCombine',
    formatOptions: {
      ...ts.getDefaultFormatCodeSettings(newLine),
      convertTabsToSpaces: !(options.useTabs ?? false),
      tabSize: tabWidth,
      indentSize: tabWidth,
    },
    // `organizeImports` reprints existing import declarations verbatim, so it never rewrites
    // module-specifier quotes and `quotePreference` has no effect here. Left empty on purpose.
    preferences: {},
  };
}
