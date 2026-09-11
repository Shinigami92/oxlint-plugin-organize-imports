import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasLanguageService } from '../src/language-service-backend';
import type * as LspBackendModule from '../src/lsp-backend';
import type { Backend } from '../src/types';

/**
 * TypeScript 7 imports successfully and reports a `version`, so selection has to probe for
 * the language service rather than parse a version string. These tests stub the module to
 * stand in for other installs, and stub the executable lookup so no server is ever resolved.
 */
async function select(): Promise<Backend> {
  vi.resetModules();
  const { selectBackend } = await import('../src/backend');

  return selectBackend();
}

/** What the repo's own `typescript` should select: the service on 5/6, the server on 7. */
const INSTALLED_KIND: Backend['kind'] = hasLanguageService() ? 'language-service' : 'lsp';

afterEach(() => {
  vi.doUnmock('typescript');
  vi.doUnmock('../src/lsp-backend');
  vi.resetModules();
});

describe('selectBackend', () => {
  it('matches the installed TypeScript', async () => {
    expect((await select()).kind).toBe(INSTALLED_KIND);
  });

  it('picks the language server for a TypeScript 7 style module', async () => {
    vi.doMock('typescript', () => ({ default: { version: '7.0.2' } }));
    vi.doMock('../src/lsp-backend', async (importOriginal) => ({
      ...(await importOriginal<typeof LspBackendModule>()),
      resolveTsgoExecutable: () => '/stub/tsgo',
    }));

    expect((await select()).kind).toBe('lsp');
  });

  it('picks the language server when the service is only partially present', async () => {
    vi.doMock('typescript', () => ({
      default: {
        version: '7.1.0',
        createLanguageService: () => {},
        getDefaultFormatCodeSettings: () => ({}),
      },
    }));
    vi.doMock('../src/lsp-backend', async (importOriginal) => ({
      ...(await importOriginal<typeof LspBackendModule>()),
      resolveTsgoExecutable: () => '/stub/tsgo',
    }));

    expect((await select()).kind).toBe('lsp');
  });

  it('surfaces a missing platform executable as its own error', async () => {
    vi.doMock('typescript', () => ({ default: { version: '7.0.2' } }));
    vi.doMock('../src/lsp-backend', async (importOriginal) => ({
      ...(await importOriginal<typeof LspBackendModule>()),
      resolveTsgoExecutable: (): string => {
        throw new Error('@typescript/typescript-test-arch is not installed');
      },
    }));

    await expect(select()).rejects.toThrow(/typescript-test-arch is not installed/u);
  });

  it('rejects a TypeScript that is neither', async () => {
    vi.doMock('typescript', () => ({ default: { version: '4.9.5' } }));

    await expect(select()).rejects.toThrow(/typescript@4\.9\.5 provides neither/u);
    await expect(select()).rejects.toThrow(/\^5, \^6 and \^7/u);
  });

  it('copes with a module that does not even report a version', async () => {
    vi.doMock('typescript', () => ({ default: {} }));

    await expect(select()).rejects.toThrow(/typescript@unknown/u);
  });
});
