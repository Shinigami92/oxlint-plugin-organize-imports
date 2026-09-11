import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSettings } from './core';
import { SyncLspClient } from './sync-lsp-client';
import type { Backend, Mode, Settings, TextChange } from './types';

/** The `package.json` of the `typescript` this plugin resolves, i.e. the consumer's. */
export function installedTypescriptPackage(): string {
  return createRequire(import.meta.url).resolve('typescript/package.json');
}

/**
 * Where `typescript@7` keeps its native executable: an optional dependency per platform,
 * installed next to the `typescript` package itself, with the binary under `lib/`.
 *
 * Mirrors `typescript/lib/getExePath.js`, which the VS Code extension keeps in sync with.
 *
 * @param typescriptPackage Path of the `package.json` to resolve from. Only tests pass
 *   anything but the installed one, to reach an aliased install of 7 while the repo's own
 *   TypeScript is 6.
 * @throws {Error} If the platform package is not installed, which is what "unsupported
 *   platform" and "optional dependencies were skipped" both look like from here.
 */
export function resolveTsgoExecutable(
  typescriptPackage: string = installedTypescriptPackage()
): string {
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;

  let platformPackageJson: string;
  try {
    platformPackageJson = createRequire(typescriptPackage).resolve(
      `${platformPackage}/package.json`
    );
  } catch {
    throw new Error(
      `oxlint-plugin-organize-imports could not find the TypeScript 7 executable: '${platformPackage}' is not installed next to ${path.dirname(typescriptPackage)}.\n\nEither ${process.platform}-${process.arch} has no TypeScript 7 build, or optional dependencies were not installed.`
    );
  }

  return path.join(
    path.dirname(platformPackageJson),
    'lib',
    process.platform === 'win32' ? 'tsc.exe' : 'tsc'
  );
}

/** The `textDocument/codeAction` kind behind each mode. */
const CODE_ACTION_KINDS: Record<Mode, string> = {
  All: 'source.organizeImports',
  SortAndCombine: 'source.sortImports',
  RemoveUnused: 'source.removeUnusedImports',
};

interface Position {
  readonly line: number;
  readonly character: number;
}

interface LspTextEdit {
  readonly range: { readonly start: Position; readonly end: Position };
  readonly newText: string;
}

interface CodeAction {
  readonly kind?: string;
  readonly edit?: {
    readonly changes?: Record<string, LspTextEdit[]>;
    readonly documentChanges?: Array<{ readonly edits?: LspTextEdit[] }>;
  };
}

/** The subset of `tsgo`'s user preferences the plugin sets. */
interface FormatPreferences {
  readonly tabSize: number;
  readonly indentSize: number;
  readonly convertTabsToSpaces: boolean;
}

function formatPreferences(settings: Settings): FormatPreferences {
  return {
    tabSize: settings.tabWidth,
    indentSize: settings.tabWidth,
    convertTabsToSpaces: !settings.useTabs,
  };
}

function sameFormat(a: FormatPreferences, b: FormatPreferences): boolean {
  return (
    a.tabSize === b.tabSize &&
    a.indentSize === b.indentSize &&
    a.convertTabsToSpaces === b.convertTabsToSpaces
  );
}

/** Offsets at which each line starts. LSP counts `\r\n`, `\n` and a lone `\r` as line breaks. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\r') {
      if (text[i + 1] === '\n') {
        i++;
      }
      starts.push(i + 1);
    } else if (char === '\n') {
      starts.push(i + 1);
    }
  }

  return starts;
}

/**
 * Turn an LSP position into an offset. Positions count UTF-16 code units, and so do
 * JavaScript string indices, so the character column needs no conversion. A position past
 * the end of the text clamps to the end, which is how the protocol defines it.
 */
export function offsetAt(starts: ReadonlyArray<number>, text: string, position: Position): number {
  const lineStart = starts[position.line];
  if (lineStart === undefined) {
    return text.length;
  }

  return Math.min(lineStart + position.character, text.length);
}

function languageIdFor(filename: string): string {
  return filename.endsWith('.tsx') ? 'typescriptreact' : 'typescript';
}

export interface LspBackendOptions {
  /** Absolute path of the `tsgo` executable; see {@link resolveTsgoExecutable}. */
  readonly executable: string;
  /**
   * Workspace root reported to the server. It has no bearing on which `tsconfig.json` a file
   * belongs to — `tsgo` walks up from the file — so the current directory is fine.
   *
   * @default process.cwd()
   */
  readonly cwd?: string;
}

/**
 * The TypeScript 7 backend: the `tsgo` language server, driven over LSP.
 *
 * TypeScript 7 no longer ships a JavaScript language service; `organizeImports` survives only
 * as the `source.organizeImports` family of code actions, which is exactly what an editor's
 * "Organize Imports" asks for. The server is started once per lint run — by `prepare()`
 * when the rule is created, or by the first file if nobody called it — and each file is a
 * `didOpen` / `codeAction` / `didClose` round trip.
 *
 * Two things differ from the in-process backend by construction:
 *
 * - The server loads the file's real project rather than a single-file program, so the first
 *   file pays for that, and a file no `tsconfig.json` includes gets default compiler options
 *   rather than the nearest tsconfig's — as it would in the editor.
 * - The server does not honour a newline preference, so line endings in its output are
 *   normalised to the file's here.
 */
export function createLspBackend(options: LspBackendOptions): Backend {
  const cwd = options.cwd ?? process.cwd();
  let client: SyncLspClient | undefined;
  /** A failed start is final for the run: retrying it for every file would multiply the wait. */
  let startupError: Error | undefined;
  let appliedFormat: FormatPreferences | undefined;

  function initialize(started: SyncLspClient, settings: Settings): void {
    const rootUri = pathToFileURL(cwd).href;
    appliedFormat = formatPreferences(settings);

    started.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(cwd) }],
      capabilities: {
        textDocument: {
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: Object.values(CODE_ACTION_KINDS) },
            },
          },
        },
      },
      initializationOptions: {
        // Nothing here ever reads diagnostics, and computing them for every file opened would
        // be the single largest cost of the run.
        disablePushDiagnostics: true,
        // Without a `workspace/configuration` capability the server takes its preferences
        // from here, in the `js/ts` section's shape.
        userPreferences: { format: appliedFormat },
      },
    });
    started.notify('initialized', {});
  }

  function connect(settings: Settings): SyncLspClient {
    if (client !== undefined) {
      return client;
    }
    if (startupError !== undefined) {
      throw startupError;
    }

    const started = new SyncLspClient({ executable: options.executable, cwd });
    try {
      initialize(started, settings);
    } catch (error) {
      started.dispose();
      startupError = error instanceof Error ? error : new Error(String(error));
      throw startupError;
    }

    client = started;

    return started;
  }

  /** Per-file options can differ between files; the server is told only when they do. */
  function applyFormat(connected: SyncLspClient, settings: Settings): void {
    const wanted = formatPreferences(settings);
    if (appliedFormat !== undefined && sameFormat(appliedFormat, wanted)) {
      return;
    }

    connected.notify('workspace/didChangeConfiguration', {
      settings: { 'js/ts': { format: wanted } },
    });
    appliedFormat = wanted;
  }

  return {
    kind: 'lsp',
    prepare(): void {
      // The one moment `fork()` is guaranteed to be cheap enough to succeed: see `Backend`.
      // Preferences are the defaults for now; the first file reconfigures if it needs to.
      connect(resolveSettings());
    },
    organize(filename, text, _tsconfigPath, settings): ReadonlyArray<TextChange> {
      const connected = connect(settings);
      applyFormat(connected, settings);

      const uri = pathToFileURL(path.resolve(filename)).href;
      const starts = lineStarts(text);

      connected.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(filename), version: 1, text },
      });
      let actions: CodeAction[] | null;
      try {
        actions = connected.request('textDocument/codeAction', {
          textDocument: { uri },
          range: { start: { line: 0, character: 0 }, end: { line: starts.length, character: 0 } },
          context: { diagnostics: [], only: [CODE_ACTION_KINDS[settings.mode]] },
        }) as CodeAction[] | null;
      } finally {
        connected.notify('textDocument/didClose', { textDocument: { uri } });
      }

      const edit = actions?.[0]?.edit;
      // The server keys `changes` by the URI it was handed, so a lookup should hit; the
      // fallback covers a server that re-spells it (drive-letter case on Windows, say).
      const edits =
        edit?.changes?.[uri] ??
        Object.values(edit?.changes ?? {})[0] ??
        edit?.documentChanges?.[0]?.edits ??
        [];

      return edits.map(({ range, newText }) => {
        const start = offsetAt(starts, text, range.start);
        const end = offsetAt(starts, text, range.end);

        return {
          span: { start, length: end - start },
          newText: newText.replaceAll(/\r\n|\n/gu, settings.newLine),
        };
      });
    },
    dispose(): void {
      client?.dispose();
      client = undefined;
      startupError = undefined;
      appliedFormat = undefined;
    },
  };
}
