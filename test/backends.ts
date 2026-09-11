import { createRequire } from 'node:module';
import { createLanguageServiceBackend, hasLanguageService } from '../src/language-service-backend';
import { createLspBackend, resolveTsgoExecutable } from '../src/lsp-backend';
import type { Backend } from '../src/types';

export interface TestBackend {
  readonly kind: Backend['kind'];
  /** Interpolated into `describe.each` titles as `$label`. */
  readonly label: string;
  create: (options?: { cwd?: string }) => Backend;
}

export const LANGUAGE_SERVICE: TestBackend = {
  kind: 'language-service',
  label: 'TypeScript 5/6 language service',
  create: () => createLanguageServiceBackend(),
};

/**
 * Runs the `tsgo` of the aliased `typescript-7` dev dependency, so this backend is under test
 * whatever `typescript` the repo itself has installed — including on CI cells that pin 5 or 6.
 */
export const TYPESCRIPT_7_PACKAGE = createRequire(import.meta.url).resolve(
  'typescript-7/package.json'
);

export const LSP: TestBackend = {
  kind: 'lsp',
  label: 'TypeScript 7 language server',
  create: ({ cwd } = {}) =>
    createLspBackend({ executable: resolveTsgoExecutable(TYPESCRIPT_7_PACKAGE), cwd }),
};

/**
 * Every backend this install can run. The language service exists only when the repo's own
 * `typescript` is 5 or 6; on a CI cell pinned to 7 it drops out and the suite runs LSP-only.
 */
export const BACKENDS: TestBackend[] = [...(hasLanguageService() ? [LANGUAGE_SERVICE] : []), LSP];

/** Pick a per-backend expectation where the two legitimately format differently. */
export function byBackend<T>(backend: TestBackend, expectations: Record<Backend['kind'], T>): T {
  return expectations[backend.kind];
}
