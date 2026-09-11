import type ts from 'typescript';

/**
 * Which organize-imports operation runs.
 *
 * - `All` — sort, merge, and remove unused imports. The editor's "Organize Imports".
 * - `SortAndCombine` — sort and merge only; nothing is removed.
 * - `RemoveUnused` — remove unused imports only; nothing is reordered.
 *
 * These are `ts.OrganizeImportsMode`'s names on TypeScript 5/6, and map onto the
 * `source.organizeImports`, `source.sortImports` and `source.removeUnusedImports` code
 * actions of the TypeScript 7 language server.
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

/**
 * Fully resolved options. Backend-neutral: each backend translates these into what its
 * TypeScript understands (`ts.FormatCodeSettings` on 5/6, LSP user preferences on 7).
 */
export interface Settings {
  readonly mode: Mode;
  /** Whether the mode can remove imports, and so change behaviour. */
  readonly destructive: boolean;
  readonly tabWidth: number;
  readonly useTabs: boolean;
  /** The file's own line ending, so the rewritten block matches the rest of the file. */
  readonly newLine: '\n' | '\r\n';
}

/**
 * One replacement in the original text. Structurally identical to `ts.TextChange`, spelled
 * out so the core never has to import a TypeScript that may not ship the type.
 */
export interface TextChange {
  readonly span: { readonly start: number; readonly length: number };
  readonly newText: string;
}

/**
 * Whatever runs `organizeImports` for a given TypeScript major.
 *
 * Two exist: the in-process language service that TypeScript 5 and 6 ship, and the `tsgo`
 * language server that is the only place the operation lives in TypeScript 7. Both hand
 * back plain text changes; everything downstream is shared.
 */
export interface Backend {
  readonly kind: 'language-service' | 'lsp';
  /**
   * Bring up whatever the backend needs before the first file, while the host process is
   * still small. The language server has to `fork()` here: once oxlint starts linting it
   * reserves tens of gigabytes of address space for its per-file arenas, and on Linux with
   * the default memory-overcommit heuristic the kernel then refuses to duplicate the process
   * for a child (`spawn ENOMEM`). Nothing to do for the in-process language service.
   */
  prepare(): void;
  /**
   * @param filename Absolute path of the file being linted.
   * @param tsconfigPath Nearest `tsconfig.json`, or `null` for compiler defaults. The
   *   language server discovers projects on its own and ignores it.
   */
  organize(
    filename: string,
    text: string,
    tsconfigPath: string | null | undefined,
    settings: Settings
  ): ReadonlyArray<TextChange>;
  /** Release whatever the backend holds — a child process, in the LSP case. */
  dispose(): void;
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

/** A single collapsed replacement covering everything the backend changed. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}
