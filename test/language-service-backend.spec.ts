import { describe, expect, it } from 'vitest';
import { resolveSettings } from '../src/core';
import {
  createLanguageServiceBackend,
  createServiceCache,
  hasLanguageService,
  toFormatCodeSettings,
} from '../src/language-service-backend';
import { LANGUAGE_SERVICE } from './backends';
import { organize } from './in-process';

/**
 * What is specific to the in-process backend: its per-tsconfig service cache and the host
 * behind it. Skipped wholesale where the installed TypeScript is 7, which has no service.
 */
describe.skipIf(!hasLanguageService())('the language-service backend', () => {
  describe('the service cache', () => {
    it('hands out one entry per tsconfig, and reuses it across files', () => {
      const getService = createServiceCache();

      expect(getService(null)).toBe(getService(null));
      expect(getService(null)).toBe(getService());
      expect(getService('/a/tsconfig.json')).not.toBe(getService('/b/tsconfig.json'));
    });

    it('bumps the script version for every file it is handed', () => {
      const backend = createLanguageServiceBackend();
      const { state } = backend.getService(null);
      const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';

      organize(text, { backend, filename: 'one.ts' });
      organize(text, { backend, filename: 'two.ts' });

      expect(state.version).toBe(2);
      expect(state.file.endsWith('two.ts')).toBe(true);
    });

    it('stores one path however the caller spelled it', () => {
      const viaNormalized = createLanguageServiceBackend();
      const viaMessy = createLanguageServiceBackend();
      const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';

      organize(text, { backend: viaNormalized, filename: '/virtual/file.ts' });
      organize(text, { backend: viaMessy, filename: '/virtual/sub/../file.ts' });

      // Deliberately not compared against a literal: `path.resolve` anchors a rooted POSIX
      // path to the current drive on Windows, so the absolute form is `D:/virtual/file.ts`
      // there. What has to hold on every platform is that both spellings land on the same
      // string, and that the separators are the ones the language service hands back.
      const messy = viaMessy.getService(null).state.file;
      expect(messy).toBe(viaNormalized.getService(null).state.file);
      expect(messy).not.toContain('\\');
      expect(messy.endsWith('/virtual/file.ts')).toBe(true);
    });
  });

  describe('toFormatCodeSettings', () => {
    it('defaults to two-space indentation', () => {
      const format = toFormatCodeSettings(resolveSettings());

      expect(format.tabSize).toBe(2);
      expect(format.indentSize).toBe(2);
      expect(format.convertTabsToSpaces).toBe(true);
    });

    it('maps tabWidth onto both tabSize and indentSize', () => {
      const format = toFormatCodeSettings(resolveSettings({ tabWidth: 4 }));

      expect(format.tabSize).toBe(4);
      expect(format.indentSize).toBe(4);
    });

    it('turns useTabs into convertTabsToSpaces: false', () => {
      expect(toFormatCodeSettings(resolveSettings({ useTabs: true })).convertTabsToSpaces).toBe(
        false
      );
    });

    it('hands the detected newline to the printer', () => {
      expect(toFormatCodeSettings(resolveSettings({}, 'a\r\nb')).newLineCharacter).toBe('\r\n');
    });
  });

  it('is what the registry creates', () => {
    expect(LANGUAGE_SERVICE.create().kind).toBe('language-service');
  });
});
