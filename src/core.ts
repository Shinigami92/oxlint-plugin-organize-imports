import { namedSpecifierLists } from './specifier-lists';
import type { Backend, Edit, Mode, RuleOptions, Settings, TextChange } from './types';

/** Apply text changes to `text`, right-to-left so earlier offsets stay valid. */
export function applyTextChanges(text: string, changes: ReadonlyArray<TextChange>): string {
  let out = text;
  for (const { span, newText } of changes.toSorted((a, b) => b.span.start - a.span.start)) {
    out = out.slice(0, span.start) + newText + out.slice(span.start + span.length);
  }

  return out;
}

/** `text`, with a comma appended to every multi-line specifier list that lacks one. */
function insertTrailingCommas(text: string): string {
  const insertAt = namedSpecifierLists(text)
    .filter((list) => list.isMultiLine && !list.hasTrailingComma)
    .map((list) => list.end)
    .toSorted((a, b) => b - a);

  let out = text;
  for (const at of insertAt) {
    out = `${out.slice(0, at)},${out.slice(at)}`;
  }

  return out;
}

/**
 * TypeScript's printer reprints *export* declarations through the emitter, which never emits
 * a trailing comma — import declarations are left verbatim, exports are not. A formatter set
 * to `trailingComma: "es5"` (prettier, oxfmt) immediately puts the comma back, so the rule and
 * the formatter would rewrite each other forever. Restoring the file's own convention makes
 * the two converge, and usually means we report nothing at all. `tsgo` inherited the printer,
 * and the behaviour, so this applies to both backends.
 *
 * The convention is read from the whole original file — an import group that was already
 * sorted may not appear in the changes at all — and the commas go into the text each change
 * produces, where the offsets need no juggling. Only lists that are multi-line and lack a
 * comma are touched, and only when a multi-line list in the original already had one.
 * Single-line lists are left alone: formatters strip trailing commas there anyway, so
 * following the emitter is the converging choice.
 */
export function restoreTrailingCommas(
  text: string,
  changes: ReadonlyArray<TextChange>
): ReadonlyArray<TextChange> {
  const usesTrailingCommas = namedSpecifierLists(text).some(
    (list) => list.isMultiLine && list.hasTrailingComma
  );
  if (!usesTrailingCommas) {
    return changes;
  }

  return changes.map((change) => ({ ...change, newText: insertTrailingCommas(change.newText) }));
}

/**
 * Run the backend's `organizeImports` on one file and collapse the result into a single
 * ranged replacement, or `null` if the file is already organized.
 *
 * TypeScript hands back a scattered list of text changes. Reporting them as one range keeps
 * the diagnostic pointed at the import block instead of rewriting the whole file, and keeps
 * the fix from colliding with unrelated rules further down.
 *
 * @param filename Absolute path of the file being linted.
 */
export function organizeFile(
  backend: Backend,
  tsconfigPath: string | null | undefined,
  filename: string,
  text: string,
  settings: Settings
): Edit | null {
  const textChanges = backend.organize(filename, text, tsconfigPath, settings);
  if (textChanges.length === 0) {
    return null;
  }

  const changes = restoreTrailingCommas(text, textChanges);
  const start = Math.min(...changes.map((change) => change.span.start));
  const end = Math.max(...changes.map((change) => change.span.start + change.span.length));

  const organized = applyTextChanges(text, changes);

  // Everything before `start` is untouched, so it lines up in both strings. Everything after
  // `end` is untouched but shifted by the net length change, so the rewritten region ends at
  // `end + delta` in the organized text.
  const delta = organized.length - text.length;
  const replacement = organized.slice(start, end + delta);

  // Both backends sometimes report a change that reproduces the original text verbatim.
  if (replacement === text.slice(start, end)) {
    return null;
  }

  return { start, end, replacement };
}

/**
 * Detect the dominant line ending, so the rewritten import block matches the rest of the file
 * instead of whatever the host platform prefers.
 */
function detectNewLine(text: string): '\n' | '\r\n' {
  const index = text.indexOf('\n');

  return index > 0 && text[index - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * @param text Source text, used to match the file's existing line endings.
 */
export function resolveSettings(options: RuleOptions = {}, text = ''): Settings {
  const mode: Mode = options.mode ?? 'All';

  return {
    mode,
    // `SortAndCombine` only reorders and merges, which preserves behaviour. The other two
    // modes delete imports, which does not.
    destructive: mode !== 'SortAndCombine',
    tabWidth: options.tabWidth ?? 2,
    useTabs: options.useTabs ?? false,
    newLine: detectNewLine(text),
  };
}
