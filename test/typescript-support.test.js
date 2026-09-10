import { describe, expect, it, vi } from 'vitest';

/**
 * TypeScript 7 imports successfully and reports a `version`, so the guard has to probe for
 * the language service API rather than parse a version string. These tests stub the module
 * to stand in for a TS 7 install, which cannot be resolved for real from this package.
 */
describe('assertLanguageServiceAvailable', () => {
  it('passes on the installed TypeScript 5/6', async () => {
    vi.resetModules();
    const { assertLanguageServiceAvailable } = await import('../src/typescript-support.js');

    expect(() => assertLanguageServiceAvailable()).not.toThrow();
  });

  it('throws a version-specific error on a TypeScript 7 style module', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => ({ default: { version: '7.0.2' } }));

    const { assertLanguageServiceAvailable } = await import('../src/typescript-support.js');

    expect(() => assertLanguageServiceAvailable()).toThrowError(
      /typescript@7\.0\.2 does not provide one/u,
    );
    expect(() => assertLanguageServiceAvailable()).toThrowError(
      /typescript@\^5 or typescript@\^6/u,
    );

    vi.doUnmock('typescript');
    vi.resetModules();
  });

  it('throws when the module has a language service but no OrganizeImportsMode', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => ({
      default: {
        version: '7.1.0',
        createLanguageService: () => {},
        getDefaultFormatCodeSettings: () => ({}),
      },
    }));

    const { assertLanguageServiceAvailable } = await import('../src/typescript-support.js');

    expect(() => assertLanguageServiceAvailable()).toThrow();

    vi.doUnmock('typescript');
    vi.resetModules();
  });
});
