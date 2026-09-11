import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyTextChanges, resolveSettings, restoreTrailingCommas } from '../src/core';
import type { TextChange } from '../src/types';
import { BACKENDS, byBackend } from './backends';
import type { VirtualProject } from './in-process';
import { createTsconfigProject, organize, organizeText } from './in-process';

/**
 * In-process counterpart to `organize-imports.spec.ts`. Same subject, one layer down: these
 * call `src/core` directly, so they run in milliseconds and can reach the paths the CLI
 * cannot address — a specific `tsconfig.json`, a chosen backend, a raw text change.
 *
 * Everything the two backends are supposed to agree on runs against both. Where they
 * legitimately differ — TypeScript 7's printer lays out a rewritten export list one specifier
 * per line — the expectation is picked per backend and the difference is stated.
 */
describe.each(BACKENDS)('organizeFile via the $label', (testBackend) => {
  const backend = testBackend.create();
  const run = (text: string, setup: Omit<Parameters<typeof organize>[1], 'backend'> = {}) =>
    organize(text, { backend, ...setup });
  const runText = (text: string, setup: Omit<Parameters<typeof organize>[1], 'backend'> = {}) =>
    organizeText(text, { backend, ...setup });

  afterAll(() => {
    backend.dispose();
  });

  it('sorts imports and collapses the change into one ranged edit', () => {
    const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';

    expect(run(text)).toEqual({
      start: 0,
      end: 50,
      replacement: 'import { a } from "./a";\nimport { b } from "./b";\n',
    });
  });

  it('returns null for a file that is already organized', () => {
    expect(run('import { a } from "./a";\n\nconsole.log(a);\n')).toBeNull();
  });

  it('returns null for a file with no imports at all', () => {
    expect(run('export const a = 1;\n')).toBeNull();
  });

  it('handles a file that does not parse', () => {
    // The language service gives up on a broken file; the language server organizes what it
    // could parse and drops the rest. Moot under oxlint, which never runs the rule on a file
    // its own parser rejected, but the difference is real and worth pinning.
    expect(run('import { from "./b"\nconsole.log(\n')).toEqual(
      byBackend(testBackend, {
        'language-service': null,
        lsp: { start: 0, end: 20, replacement: '' },
      })
    );
  });

  it('merges duplicate imports from one specifier', () => {
    const text = 'import { b } from "./m";\nimport { a } from "./m";\n\nconsole.log(a, b);\n';

    expect(runText(text)).toBe('import { a, b } from "./m";\n\nconsole.log(a, b);\n');
  });

  it('starts the edit after a BOM rather than replacing it', () => {
    const text = '﻿import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';
    const edit = run(text);

    expect(edit?.start).toBe(1);
    expect(runText(text).startsWith('﻿')).toBe(true);
  });

  describe('modes', () => {
    const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(b);\n';

    it('"All" sorts and removes what is unused', () => {
      expect(runText(text)).toBe('import { b } from "./b";\n\nconsole.log(b);\n');
    });

    it('"SortAndCombine" keeps the unused import', () => {
      expect(runText(text, { options: { mode: 'SortAndCombine' } })).toBe(
        'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(b);\n'
      );
    });

    it('"RemoveUnused" removes without reordering the rest', () => {
      const unsorted = 'import { c } from "./c";\nimport { a } from "./a";\n\nconsole.log(c);\n';

      expect(runText(unsorted, { options: { mode: 'RemoveUnused' } })).toBe(
        'import { c } from "./c";\n\nconsole.log(c);\n'
      );
    });
  });

  describe('formatting', () => {
    const multiLine =
      'import {\n  b,\n  b2,\n} from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b, b2);\n';

    it('reindents a multi-line list with the default two spaces', () => {
      expect(runText(multiLine)).toBe(
        'import { a } from "./a";\nimport {\n  b,\n  b2,\n} from "./b";\n\nconsole.log(a, b, b2);\n'
      );
    });

    it('honours tabWidth', () => {
      expect(runText(multiLine, { options: { tabWidth: 4 } })).toBe(
        'import { a } from "./a";\nimport {\n    b,\n    b2,\n} from "./b";\n\nconsole.log(a, b, b2);\n'
      );
    });

    it('honours useTabs', () => {
      expect(runText(multiLine, { options: { useTabs: true } })).toBe(
        'import { a } from "./a";\nimport {\n\tb,\n\tb2,\n} from "./b";\n\nconsole.log(a, b, b2);\n'
      );
    });

    it('writes CRLF into a CRLF file', () => {
      const text =
        'import { b } from "./b";\r\nimport { a } from "./a";\r\n\r\nconsole.log(a, b);\r\n';
      const result = runText(text);

      expect(result).toBe(
        'import { a } from "./a";\r\nimport { b } from "./b";\r\n\r\nconsole.log(a, b);\r\n'
      );
      expect(/[^\r]\n/u.test(result)).toBe(false);
    });

    it('writes CRLF into a rewritten multi-line list in a CRLF file', () => {
      const text = multiLine.replaceAll('\n', '\r\n');
      const result = runText(text);

      expect(result).toBe(
        'import { a } from "./a";\r\nimport {\r\n  b,\r\n  b2,\r\n} from "./b";\r\n\r\nconsole.log(a, b, b2);\r\n'
      );
    });
  });

  describe('trailing commas', () => {
    it('restores the comma the emitter drops from a multi-line export list', () => {
      expect(runText('export {\n  b,\n  a,\n} from "./m";\n')).toBe(
        byBackend(testBackend, {
          'language-service': 'export {\n  a, b,\n} from "./m";\n',
          lsp: 'export {\n  a,\n  b,\n} from "./m";\n',
        })
      );
    });

    it('does not invent one in a file that does not use them', () => {
      expect(runText('export {\n  b,\n  a\n} from "./m";\n')).toBe(
        byBackend(testBackend, {
          'language-service': 'export {\n  a, b\n} from "./m";\n',
          lsp: 'export {\n  a,\n  b\n} from "./m";\n',
        })
      );
    });

    it('restores every list inside the rewritten region, not just the first', () => {
      const text = 'export {\n  d,\n  c,\n} from "./d";\nexport {\n  b,\n  a,\n} from "./b";\n';

      expect(runText(text)).toBe(
        byBackend(testBackend, {
          'language-service':
            'export {\n  a, b,\n} from "./b";\nexport {\n  c, d,\n} from "./d";\n',
          lsp: 'export {\n  a,\n  b,\n} from "./b";\nexport {\n  c,\n  d,\n} from "./d";\n',
        })
      );
    });

    it('takes the convention from a multi-line import list too', () => {
      const text =
        'import {\n  x,\n  y,\n} from "./x";\nexport {\n  b,\n  a\n} from "./m";\n\nconsole.log(x, y);\n';

      expect(runText(text)).toContain(
        byBackend(testBackend, {
          'language-service': 'export {\n  a, b,\n} from "./m";',
          lsp: 'export {\n  a,\n  b,\n} from "./m";',
        })
      );
    });

    it('leaves a single-line export list alone', () => {
      expect(runText('export { b, a } from "./m";\n')).toBe('export { a, b } from "./m";\n');
    });
  });

  describe('compiler options from a tsconfig', () => {
    const source =
      'import { useState } from "react";\nimport React from "react";\n\nexport const A = () => <div>{useState(0)[0]}</div>;\n';
    const projects: VirtualProject[] = [];

    function project(compilerOptions: Record<string, unknown>): VirtualProject {
      const created = createTsconfigProject(testBackend, compilerOptions);
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
      // backend still runs, it just runs without the project's options.
      expect(runText(text, { tsconfigPath: '/no/such/directory/tsconfig.json' })).toBe(
        'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a, b);\n'
      );
    });

    it('answers the same for every file of one project', () => {
      const created = project({ jsx: 'react' });
      const first = created.organize(source, { filename: 'App.tsx' });

      // The second call hits whatever the backend caches: parsed compiler options and the
      // language service on one side, the loaded project on the other.
      expect(created.organize(source, { filename: 'other.tsx' })).toEqual(first);
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
      expect(runText(text, { filename: '/virtual/./file.ts' })).toBe(organized);
    });

    it('organizes a path containing a ".." segment', () => {
      expect(runText(text, { filename: '/virtual/sub/../file.ts' })).toBe(organized);
    });

    it('organizes a path containing redundant separators', () => {
      expect(runText(text, { filename: '/virtual//file.ts' })).toBe(organized);
    });

    it('reads the text it was handed, not the file on disk', () => {
      const created = createTsconfigProject(testBackend, {});
      // Same import names, opposite order: if the backend fell through to the file on disk,
      // this already-sorted text is what would get organized, and the call would report no
      // change at all. The project helper writes `text` to disk first; overwrite it.
      const onDisk = path.join(created.dir, 'disk.ts');
      const edit = created.organize(text, { filename: 'disk.ts' });
      fs.writeFileSync(onDisk, organized);

      try {
        expect(edit).not.toBeNull();
        expect(created.organizeText(text, { filename: 'disk.ts' })).toBe(organized);
        expect(fs.readFileSync(onDisk, 'utf8')).toBe(text);
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
    const changes: TextChange[] = [
      { span: { start: 0, length: 3 }, newText: 'first' },
      { span: { start: 6, length: 4 }, newText: 'second' },
    ];

    expect(applyTextChanges('one + four', changes)).toBe('first + second');
  });

  it('handles a zero-length span as an insertion', () => {
    const changes: TextChange[] = [{ span: { start: 3, length: 0 }, newText: '!' }];

    expect(applyTextChanges('abcdef', changes)).toBe('abc!def');
  });
});

describe('restoreTrailingCommas', () => {
  const original = 'export {\n  b,\n  a,\n} from "./m";\n';

  it('adds a comma to a multi-line list the change dropped it from', () => {
    const changes: TextChange[] = [
      { span: { start: 0, length: original.length }, newText: 'export {\n  a, b\n} from "./m";\n' },
    ];

    expect(restoreTrailingCommas(original, changes)).toEqual([
      {
        span: { start: 0, length: original.length },
        newText: 'export {\n  a, b,\n} from "./m";\n',
      },
    ]);
  });

  it('returns the changes untouched when the original had no trailing commas', () => {
    const plain = 'export {\n  b,\n  a\n} from "./m";\n';
    const changes: TextChange[] = [
      { span: { start: 0, length: plain.length }, newText: 'export {\n  a, b\n} from "./m";\n' },
    ];

    expect(restoreTrailingCommas(plain, changes)).toBe(changes);
  });

  it('reads the convention from the whole file, not just the replaced spans', () => {
    // TypeScript 5/6 leaves an already-sorted import group out of its changes entirely, so a
    // file whose only trailing comma sits in such a group would otherwise lose the comma on
    // its rewritten export.
    const imports = 'import {\n  x,\n  y,\n} from "./x";\n';
    const exports = 'export {\n  b,\n  a\n} from "./m";\n';
    const changes: TextChange[] = [
      {
        span: { start: imports.length, length: exports.length },
        newText: 'export {\n  a, b\n} from "./m";\n',
      },
    ];

    expect(restoreTrailingCommas(imports + exports, changes)[0]?.newText).toBe(
      'export {\n  a, b,\n} from "./m";\n'
    );
  });
});

describe('resolveSettings', () => {
  it('defaults to mode "All" with two-space indentation', () => {
    expect(resolveSettings()).toEqual({
      mode: 'All',
      destructive: true,
      tabWidth: 2,
      useTabs: false,
      newLine: '\n',
    });
  });

  it.each([
    ['All', true],
    ['RemoveUnused', true],
    ['SortAndCombine', false],
  ] as const)('marks mode "%s" destructive: %s', (mode, destructive) => {
    expect(resolveSettings({ mode }).destructive).toBe(destructive);
  });

  it('passes tabWidth and useTabs through', () => {
    expect(resolveSettings({ tabWidth: 4, useTabs: true })).toMatchObject({
      tabWidth: 4,
      useTabs: true,
    });
  });

  it.each([
    ['empty text', '', '\n'],
    ['an LF file', 'const a = 1;\nconst b = 2;\n', '\n'],
    ['a CRLF file', 'const a = 1;\r\nconst b = 2;\r\n', '\r\n'],
    ['a file with no line ending at all', 'const a = 1;', '\n'],
  ])('picks the newline of %s', (_label, text, newLine) => {
    expect(resolveSettings({}, text).newLine).toBe(newLine);
  });
});
