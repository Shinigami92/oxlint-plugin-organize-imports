/** Files containing this marker are left alone (same convention as `prettier-plugin-organize-imports`). */
export const IGNORE_MARKER = '// organize-imports-ignore';

/** The language service only handles TypeScript here; oxlint has no custom-parser support yet. */
const TS_FILE = /\.(?:m|c)?tsx?$/u;

/**
 * Whether the plugin will consider this file at all.
 *
 * The marker is matched anywhere in the text, including inside strings and comments. That is
 * deliberately the same loose check `prettier-plugin-organize-imports` uses, and it means a
 * file that merely *mentions* the marker opts itself out — including this plugin's own
 * sources and tests.
 */
export function isOrganizable(filename: string, text: string): boolean {
  return TS_FILE.test(filename) && !text.includes(IGNORE_MARKER);
}
