import type ts from 'typescript';

/**
 * Which `ts.OrganizeImportsMode` the language service runs in.
 *
 * - `All` — sort, merge, and remove unused imports. The editor's "Organize Imports".
 * - `SortAndCombine` — sort and merge only; nothing is removed.
 * - `RemoveUnused` — remove unused imports only; nothing is reordered.
 */
export type Mode = 'All' | 'SortAndCombine' | 'RemoveUnused';

/** Options for the `organize-imports/organize-imports` rule. */
export interface RuleOptions {
  /**
   * @default 'All'
   */
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

/** Fully resolved options, as handed to the language service. */
export interface Settings {
  readonly mode: Mode;
  /** Whether the mode can remove imports, and so change behaviour. */
  readonly destructive: boolean;
  readonly formatOptions: ts.FormatCodeSettings;
  readonly preferences: ts.UserPreferences;
}

/** Mutable state the `LanguageServiceHost` reads for the file currently being linted. */
export interface ServiceState {
  file: string;
  text: string;
  version: number;
  cwd: string;
}

export interface ServiceEntry {
  readonly service: ts.LanguageService;
  readonly state: ServiceState;
}

export type GetService = (tsconfigPath?: string | null) => ServiceEntry;

/** A single collapsed replacement covering everything the language service changed. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}
