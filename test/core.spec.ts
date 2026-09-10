import fs from 'node:fs';
import path from 'node:path';
import type ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { applyTextChanges, createServiceCache, resolveSettings } from '../src/core';
import type { VirtualProject } from './in-process';
import { createTsconfigProject, organize, organizeText } from './in-process';

/**
 * In-process counterpart to `organize-imports.spec.ts`. Same subject, one layer down: these
 * call `src/core` directly, so they run in milliseconds and can reach the paths the CLI
 * cannot address — a specific `tsconfig.json`, a shared service cache, a raw text change.
 */
describe('organizeFile', () => {
  it('sorts imports and collapses the change into one ranged edit', () => {
    const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';

    expect(organize(text)).toEqual({
      start: 0,
      end: 50,
      replacement: 'import { a } from "./a";\nimport { b } from "./b";\n',
    });
  });

  it('returns null for a file that is already organized', () => {
    expect(organize('import { a } from "./a";\n\nconsole.log(a);\n')).toBeNull();
  });

  it('returns null for a file with no imports at all', () => {
    expect(organize('export const a = 1;\n')).toBeNull();
  });

  it('returns null for a file that does not parse', () => {
    expect(organize('import { from "./b"\nconsole.log(\n')).toBeNull();
  });

  it('merges duplicate imports from one specifier', () => {
    const text = 'import { b } from "./m";\nimport { a } from "./m";\n\nconsole.log(a, b);\n';

    expect(organizeText(text)).toBe('import { a, b } from "./m";\n\nconsole.log(a, b);\n');
  });

  it('starts the edit after a BOM rather than replacing it', () => {
    const text = '﻿import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';
    const edit = organize(text);

    expect(edit?.start).toBe(1);
    expect(organizeText(text).startsWith('﻿')).toBe(true);
  });

  describe('modes', () => {
    const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(b);\n';

    it('"All" sorts and removes what is unused', () => {
      expect(organizeText(text)).toBe('import { b } from "./b";\n\nconsole.log(b);\n');
    });

    it('"SortAndCombine" keeps the unused import', () => {
      expect(organizeText(text, { options: { mode: 'SortAndCombine' } })).toBe(
        'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(b);\n'
      );
    });

    it('"RemoveUnused" removes without reordering the rest', () => {
      const unsorted = 'import { c } from "./c";\nimport { a } from "./a";\n\nconsole.log(c);\n';

      expect(organizeText(unsorted, { options: { mode: 'RemoveUnused' } })).toBe(
        'import { c } from "./c";\n\nconsole.log(c);\n'
      );
    });
  });

  describe('formatting', () => {
    const multiLine =
      'import {\n  b,\n  b2,\n} from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b, b2);\n';

    it('reindents a multi-line list with the default two spaces', () => {
      expect(organizeText(multiLine)).toBe(
        'import { a } from "./a";\nimport {\n  b,\n  b2,\n} from "./b";\n\nconsole.log(a, b, b2);\n'
      );
    });

    it('honours tabWidth', () => {
      expect(organizeText(multiLine, { options: { tabWidth: 4 } })).toBe(
        'import { a } from "./a";\nimport {\n    b,\n    b2,\n} from "./b";\n\nconsole.log(a, b, b2);\n'
      );
    });

    it('honours useTabs', () => {
      expect(organizeText(multiLine, { options: { useTabs: true } })).toBe(
        'import { a } from "./a";\nimport {\n\tb,\n\tb2,\n} from "./b";\n\nconsole.log(a, b, b2);\n'
      );
    });

    it('writes CRLF into a CRLF file', () => {
      const text =
        'import { b } from "./b";\r\nimport { a } from "./a";\r\n\r\nconsole.log(a, b);\r\n';
      const result = organizeText(text);

      expect(result).toBe(
        'import { a } from "./a";\r\nimport { b } from "./b";\r\n\r\nconsole.log(a, b);\r\n'
      );
      expect(/[^\r]\n/u.test(result)).toBe(false);
    });
  });

  describe('trailing commas', () => {
    it('restores the comma the emitter drops from a multi-line export list', () => {
      expect(organizeText('export {\n  b,\n  a,\n} from "./m";\n')).toBe(
        'export {\n  a, b,\n} from "./m";\n'
      );
    });

    it('does not invent one in a file that does not use them', () => {
      expect(organizeText('export {\n  b,\n  a\n} from "./m";\n')).toBe(
        'export {\n  a, b\n} from "./m";\n'
      );
    });

    it('restores every list inside the rewritten region, not just the first', () => {
      const text = 'export {\n  d,\n  c,\n} from "./d";\nexport {\n  b,\n  a,\n} from "./b";\n';

      expect(organizeText(text)).toBe(
        'export {\n  a, b,\n} from "./b";\nexport {\n  c, d,\n} from "./d";\n'
      );
    });

    it('leaves a single-line export list alone', () => {
      expect(organizeText('export { b, a } from "./m";\n')).toBe('export { a, b } from "./m";\n');
    });
  });

  describe('compiler options from a tsconfig', () => {
    const source =
      'import { useState } from "react";\nimport React from "react";\n\nexport const A = () => <div>{useState(0)[0]}</div>;\n';
    const projects: VirtualProject[] = [];

    function project(compilerOptions: Record<string, unknown>): VirtualProject {
      const created = createTsconfigProject(compilerOptions);
      projects.push(created);

      return created;
    }

    afterAll(() => {
      for (const created of projects) {
        created.dispose();
      }
    });

    it('keeps React under the classic runtime, where JSX uses it', () => {
      expect(project({ jsx: 'react' }).organizeText(source, { filename: 'App.tsx' })).toBe(
        'import React, { useState } from "react";\n\nexport const A = () => <div>{useState(0)[0]}</div>;\n'
      );
    });

    it('removes React under the automatic runtime, where it is unused', () => {
      expect(project({ jsx: 'react-jsx' }).organizeText(source, { filename: 'App.tsx' })).toBe(
        'import { useState } from "react";\n\nexport const A = () => <div>{useState(0)[0]}</div>;\n'
      );
    });

    it('degrades to the defaults when the tsconfig cannot be read', () => {
      const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';

      // A path that does not exist is the cheapest stand-in for an unreadable config: the
      // language service still runs, it just runs without the project's options.
      expect(organizeText(text, { tsconfigPath: '/no/such/directory/tsconfig.json' })).toBe(
        'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a, b);\n'
      );
    });

    it('reads each tsconfig once and reuses the result', () => {
      const created = project({ jsx: 'react' });
      const first = created.organize(source, { filename: 'App.tsx' });

      // The second call hits both caches: the parsed compiler options and the service.
      expect(created.organize(source, { filename: 'other.tsx' })).toEqual(first);
    });
  });

  describe('the service cache', () => {
    it('hands out one entry per tsconfig, and reuses it across files', () => {
      const getService = createServiceCache();

      expect(getService(null)).toBe(getService(null));
      expect(getService(null)).toBe(getService());
      expect(getService('/a/tsconfig.json')).not.toBe(getService('/b/tsconfig.json'));
    });

    it('bumps the script version for every file it is handed', () => {
      const getService = createServiceCache();
      const { state } = getService(null);
      const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';

      organize(text, { getService, filename: 'one.ts' });
      organize(text, { getService, filename: 'two.ts' });

      expect(state.version).toBe(2);
      expect(state.file.endsWith('two.ts')).toBe(true);
    });
  });

  describe('script paths', () => {
    const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';
    const organized = 'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a, b);\n';

    // The language service normalises every path before calling back into the host, so the
    // host has to store the normalised form or `getScriptSnapshot` never matches. On Windows
    // that used to miss on *every* file, because `path.resolve` yields backslashes there.
    // These cases reproduce the same mismatch on any platform.
    it('organizes a path containing a "." segment', () => {
      expect(organizeText(text, { filename: '/virtual/./file.ts' })).toBe(organized);
    });

    it('organizes a path containing a ".." segment', () => {
      expect(organizeText(text, { filename: '/virtual/sub/../file.ts' })).toBe(organized);
    });

    it('organizes a path containing redundant separators', () => {
      expect(organizeText(text, { filename: '/virtual//file.ts' })).toBe(organized);
    });

    it('stores one path however the caller spelled it', () => {
      const viaNormalized = createServiceCache();
      const viaMessy = createServiceCache();

      organize(text, { getService: viaNormalized, filename: '/virtual/file.ts' });
      organize(text, { getService: viaMessy, filename: '/virtual/sub/../file.ts' });

      // Deliberately not compared against a literal: `path.resolve` anchors a rooted POSIX
      // path to the current drive on Windows, so the absolute form is `D:/virtual/file.ts`
      // there. What has to hold on every platform is that both spellings land on the same
      // string, and that the separators are the ones the language service hands back.
      expect(viaMessy(null).state.file).toBe(viaNormalized(null).state.file);
      expect(viaMessy(null).state.file).not.toContain('\\');
      expect(viaMessy(null).state.file.endsWith('/virtual/file.ts')).toBe(true);
    });

    it('reads the text it was handed, not the file on disk', () => {
      const created = createTsconfigProject({});
      // Same import names, opposite order: if the snapshot missed and the host fell through
      // to `ts.sys.readFile`, this file is what would get organized, and it is already sorted
      // — so the call would report no change at all.
      fs.writeFileSync(
        path.join(created.dir, 'disk.ts'),
        'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a, b);\n'
      );

      try {
        expect(created.organizeText(text, { filename: 'disk.ts' })).toBe(organized);
      } finally {
        created.dispose();
      }
    });
  });
});

describe('applyTextChanges', () => {
  it('returns the text unchanged for an empty change list', () => {
    expect(applyTextChanges('const a = 1;', [])).toBe('const a = 1;');
  });

  it('applies changes right to left, so earlier offsets stay valid', () => {
    const changes: ts.TextChange[] = [
      { span: { start: 0, length: 3 }, newText: 'first' },
      { span: { start: 6, length: 4 }, newText: 'second' },
    ];

    expect(applyTextChanges('one + four', changes)).toBe('first + second');
  });

  it('handles a zero-length span as an insertion', () => {
    const changes: ts.TextChange[] = [{ span: { start: 3, length: 0 }, newText: '!' }];

    expect(applyTextChanges('abcdef', changes)).toBe('abc!def');
  });
});

describe('resolveSettings', () => {
  it('defaults to mode "All" with two-space indentation', () => {
    const settings = resolveSettings();

    expect(settings.mode).toBe('All');
    expect(settings.destructive).toBe(true);
    expect(settings.formatOptions.tabSize).toBe(2);
    expect(settings.formatOptions.indentSize).toBe(2);
    expect(settings.formatOptions.convertTabsToSpaces).toBe(true);
    expect(settings.preferences).toEqual({});
  });

  it.each([
    ['All', true],
    ['RemoveUnused', true],
    ['SortAndCombine', false],
  ] as const)('marks mode "%s" destructive: %s', (mode, destructive) => {
    expect(resolveSettings({ mode }).destructive).toBe(destructive);
  });

  it('maps tabWidth onto both tabSize and indentSize', () => {
    const { formatOptions } = resolveSettings({ tabWidth: 4 });

    expect(formatOptions.tabSize).toBe(4);
    expect(formatOptions.indentSize).toBe(4);
  });

  it('turns useTabs into convertTabsToSpaces: false', () => {
    expect(resolveSettings({ useTabs: true }).formatOptions.convertTabsToSpaces).toBe(false);
  });

  it.each([
    ['empty text', '', '\n'],
    ['an LF file', 'const a = 1;\nconst b = 2;\n', '\n'],
    ['a CRLF file', 'const a = 1;\r\nconst b = 2;\r\n', '\r\n'],
    ['a file with no line ending at all', 'const a = 1;', '\n'],
  ])('picks the newline of %s', (_label, text, newLineCharacter) => {
    expect(resolveSettings({}, text).formatOptions.newLineCharacter).toBe(newLineCharacter);
  });
});
