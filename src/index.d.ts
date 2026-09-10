import type { Plugin } from '@oxlint/plugins';

/**
 * Which `ts.OrganizeImportsMode` the language service runs in.
 *
 * - `All` — sort, merge, and remove unused imports. The editor's "Organize Imports".
 * - `SortAndCombine` — sort and merge only; nothing is removed.
 * - `RemoveUnused` — remove unused imports only; nothing is reordered.
 */
export type Mode = 'All' | 'SortAndCombine' | 'RemoveUnused';

/** Options for the `organize-imports/organize-imports` rule. */
export interface OrganizeImportsOptions {
  /** @default 'All' */
  mode?: Mode;
  /**
   * Indent width for multi-line specifier lists.
   *
   * @default 2
   */
  tabWidth?: number;
  /**
   * Indent multi-line specifier lists with tabs.
   *
   * @default false
   */
  useTabs?: boolean;
}

declare const plugin: Plugin;

export default plugin;
