import ts from 'typescript';

/**
 * TypeScript 7 (the Go port) no longer ships the JavaScript language service.
 * Its package exports are a version stub plus `typescript/unstable/{sync,async,ast,proto,fs}`,
 * the sync API is compiler/checker only, and `organizeImports` does not appear anywhere in
 * the published `dist`. The operation exists only in the tsgo LSP, as the
 * `source.organizeImports` code action.
 *
 * Importing `typescript@7` succeeds and even reports a `version`, so the only reliable probe
 * is to look for the API we actually need.
 *
 * @throws {Error} If the installed TypeScript cannot run `organizeImports`.
 */
export function assertLanguageServiceAvailable(): void {
  if (
    typeof ts.createLanguageService === 'function' &&
    typeof ts.getDefaultFormatCodeSettings === 'function' &&
    ts.OrganizeImportsMode !== undefined
  ) {
    return;
  }

  const version = typeof ts.version === 'string' ? ts.version : 'unknown';

  throw new Error(
    `oxlint-plugin-organize-imports requires a TypeScript with the JavaScript language service, but typescript@${version} does not provide one.\n\nTypeScript 7 (the Go port) dropped the JS language service, and 'organizeImports' now exists only in the tsgo LSP as the 'source.organizeImports' code action.\n\nInstall typescript@^5 or typescript@^6 alongside this plugin. Note that 'typescript@latest' now resolves to 7.x, so the version must be pinned explicitly.`
  );
}
