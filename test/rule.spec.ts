import type { Context, CreateOnceRule, Diagnostic, ESTree, Fix, Fixer } from '@oxlint/plugins';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import plugin from '../src/index';
import { organizeImportsRule } from '../src/rule';
import type { RuleOptions } from '../src/types';
import { createTsconfigProject } from './in-process';

/**
 * Drives the rule the way oxlint does — one `createOnce`, then `before()` and `Program` per
 * file against a context whose `filename` and `sourceCode` change underneath it. The CLI
 * suite proves the wiring against the real linter; this reaches into the rule's own branches,
 * notably the fix-versus-suggestion split and the per-directory tsconfig cache.
 */

interface RunResult {
  /** Whether `before()` let the file through. */
  eligible: boolean;
  diagnostics: Diagnostic[];
}

interface Runner {
  run: (filename: string, text: string, options?: RuleOptions) => RunResult;
}

/**
 * A `Program` node carrying just what the rule reads: `body`, scanned for the first
 * `ImportDeclaration` to point the diagnostic at. Built from TypeScript's own parse, so the
 * ranges are real ones.
 */
function createProgramNode(filename: string, text: string): ESTree.Program {
  const sourceFile = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const body = sourceFile.statements.map((statement) => ({
    type: ts.isImportDeclaration(statement) ? 'ImportDeclaration' : 'ExpressionStatement',
    range: [statement.getStart(sourceFile), statement.getEnd()],
  }));

  return { type: 'Program', body, range: [0, text.length] } as unknown as ESTree.Program;
}

/**
 * One initialized rule plus the mutable stub context behind it. Only the handful of members
 * the rule touches are provided; the real `Context` is far too wide to build by hand.
 */
function createRunner(): Runner {
  const state = { filename: '', text: '', options: [] as RuleOptions[] };
  let reported: Diagnostic[] = [];

  const context = {
    id: 'organize-imports/organize-imports',
    get filename(): string {
      return state.filename;
    },
    get options(): RuleOptions[] {
      return state.options;
    },
    get sourceCode(): { text: string } {
      return { text: state.text };
    },
    report(diagnostic: Diagnostic): void {
      reported.push(diagnostic);
    },
  } as unknown as Context;

  const visitor = (organizeImportsRule as CreateOnceRule).createOnce(context);

  return {
    run(filename, text, options): RunResult {
      state.filename = filename;
      state.text = text;
      state.options = options === undefined ? [] : [options];
      reported = [];

      if (visitor.before?.() === false) {
        return { eligible: false, diagnostics: [] };
      }

      visitor.Program?.(createProgramNode(filename, text));
      visitor.after?.();

      return { eligible: true, diagnostics: reported };
    },
  };
}

function run(filename: string, text: string, options?: RuleOptions): RunResult {
  return createRunner().run(filename, text, options);
}

const FIXER = {
  replaceTextRange: (range: [number, number], replacement: string): Fix => ({
    range,
    text: replacement,
  }),
} as unknown as Fixer;

/** Run a diagnostic's or suggestion's `fix` through a stub fixer and apply the result. */
function applyFix(fix: NonNullable<Diagnostic['fix']>, text: string): string {
  const { range, text: replacement } = fix(FIXER) as Fix;

  return text.slice(0, range[0]) + replacement + text.slice(range[1]);
}

/** The text a diagnostic's single suggestion would produce, for the cases that read it back. */
function applySuggestion(result: RunResult, text: string): string {
  const [suggestion] = result.diagnostics[0]?.suggest ?? [];
  if (suggestion === undefined) {
    throw new Error('Expected a suggestion.');
  }

  return applyFix(suggestion.fix, text);
}

const project = createTsconfigProject({ target: 'ES2022', strict: true });
const file = (name: string): string => path.join(project.dir, name);

afterAll(() => {
  project.dispose();
});

const UNSORTED = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';
const SORTED = 'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a, b);\n';
/** Whether `React` survives depends on `jsx`, which only a tsconfig can supply. */
const JSX =
  'import { useState } from "react";\nimport React from "react";\n\nexport const A = () => <div>{useState(0)[0]}</div>;\n';
/** Sorted already, so only a mode that removes something reports on it. */
const UNUSED = 'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a);\n';

describe('the plugin', () => {
  it('exposes the rule under the name oxlint reports', () => {
    expect(plugin.meta?.name).toBe('organize-imports');
    expect(plugin.rules['organize-imports']).toBe(organizeImportsRule);
  });

  it('declares itself fixable and suggestion-capable', () => {
    expect(organizeImportsRule.meta?.fixable).toBe('code');
    expect(organizeImportsRule.meta?.hasSuggestions).toBe(true);
  });
});

describe('before', () => {
  it('lets a TypeScript file through', () => {
    expect(run(file('entry.ts'), UNSORTED).eligible).toBe(true);
  });

  it('skips a file this plugin cannot organize', () => {
    expect(run(file('entry.js'), UNSORTED).eligible).toBe(false);
  });

  it('skips a file carrying the ignore marker', () => {
    expect(run(file('entry.ts'), `// organize-imports-ignore\n${UNSORTED}`).eligible).toBe(false);
  });

  it('re-reads the options for every file, as createOnce requires', () => {
    const runner = createRunner();

    expect(runner.run(file('entry.ts'), UNSORTED).diagnostics[0]?.suggest).toHaveLength(1);
    expect(
      runner.run(file('entry.ts'), UNSORTED, { mode: 'SortAndCombine' }).diagnostics[0]?.suggest
    ).toBeUndefined();
  });
});

describe('Program', () => {
  it('reports nothing for an organized file', () => {
    expect(run(file('entry.ts'), SORTED).diagnostics).toEqual([]);
  });

  it('reports once, pointing at the first import', () => {
    const [diagnostic, ...rest] = run(file('entry.ts'), UNSORTED).diagnostics;

    expect(rest).toEqual([]);
    expect(diagnostic?.messageId).toBe('unorganized');
    expect(diagnostic?.node?.range).toEqual([0, 24]);
  });

  it('falls back to the Program node when there is no import to point at', () => {
    const source = 'export { b, a } from "./m";\n';
    const [diagnostic] = run(file('entry.ts'), source).diagnostics;

    expect(diagnostic?.node?.range).toEqual([0, source.length]);
  });

  describe('fix tiering', () => {
    it('offers a destructive mode as a suggestion, never as a plain fix', () => {
      const result = run(file('entry.ts'), UNSORTED);
      const [diagnostic] = result.diagnostics;

      expect(diagnostic?.fix).toBeUndefined();
      expect(diagnostic?.suggest).toHaveLength(1);
      expect(diagnostic?.suggest?.[0]?.desc).toBe('Organize imports');
      expect(applySuggestion(result, UNSORTED)).toBe(SORTED);
    });

    it.each(['All', 'RemoveUnused'] as const)('mode "%s" is a suggestion', (mode) => {
      const [diagnostic] = run(file('entry.ts'), UNUSED, { mode }).diagnostics;

      expect(diagnostic?.fix).toBeUndefined();
      expect(diagnostic?.suggest).toHaveLength(1);
    });

    it('offers "SortAndCombine" as a plain fix, since it cannot change behaviour', () => {
      const [diagnostic] = run(file('entry.ts'), UNSORTED, { mode: 'SortAndCombine' }).diagnostics;
      const fix = diagnostic?.fix as NonNullable<Diagnostic['fix']>;

      expect(diagnostic?.suggest).toBeUndefined();
      expect(applyFix(fix, UNSORTED)).toBe(SORTED);
    });
  });

  it('walks up for a tsconfig once per directory, not once per file', () => {
    // `ts.findConfigFile` is a getter-only export, so the cache is observed rather than
    // counted: `jsx: react` keeps the `React` import, and losing the config drops it. Once
    // the tsconfig is deleted, only a directory that was never looked up notices.
    const cached = createTsconfigProject({ jsx: 'react' });

    try {
      const nested = path.join(cached.dir, 'nested');
      fs.mkdirSync(nested, { recursive: true });

      const runner = createRunner();
      const organized = (name: string): string =>
        applySuggestion(runner.run(path.join(cached.dir, name), JSX), JSX);

      expect(organized('One.tsx')).toContain('React');

      fs.rmSync(cached.tsconfigPath);

      // Same directory: answered from the cache, so the deleted config still applies.
      expect(organized('Two.tsx')).toContain('React');

      // A directory seen for the first time walks up now, finds nothing, and loses `jsx`,
      // which is what makes `React` look unused.
      const fresh = runner.run(path.join(nested, 'Three.tsx'), JSX);
      expect(applySuggestion(fresh, JSX)).not.toContain('React');
    } finally {
      cached.dispose();
    }
  });
});
