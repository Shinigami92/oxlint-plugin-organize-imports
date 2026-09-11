import ts from 'typescript';
import { createLanguageServiceBackend, hasLanguageService } from './language-service-backend';
import { createLspBackend, resolveTsgoExecutable } from './lsp-backend';
import type { Backend } from './types';

/**
 * The backend for whichever `typescript` the consumer installed.
 *
 * TypeScript 5 and 6 ship the JavaScript language service, so `organizeImports` runs in
 * this process. TypeScript 7 (the Go port) does not: its package exports are a version stub
 * plus `typescript/unstable/*`, and the operation exists only in the `tsgo` language server,
 * which is driven over LSP instead. The language service is probed for rather than the
 * version parsed, because importing `typescript@7` succeeds and reports a `version` too.
 *
 * @throws {Error} If the installed TypeScript is neither.
 */
export function selectBackend(): Backend {
  if (hasLanguageService()) {
    return createLanguageServiceBackend();
  }

  const version = typeof ts.version === 'string' ? ts.version : 'unknown';
  const major = Number(/^\d+/u.exec(version)?.[0]);
  if (major >= 7) {
    return createLspBackend({ executable: resolveTsgoExecutable() });
  }

  throw new Error(
    `oxlint-plugin-organize-imports supports typescript@^5, ^6 and ^7, but typescript@${version} provides neither the JavaScript language service nor the tsgo language server.`
  );
}
