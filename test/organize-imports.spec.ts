import { afterEach, describe, expect, it } from 'vitest';
import { createProject } from './harness';
import type { Project, ProjectSetup } from './harness';

const projects: Project[] = [];

function project(setup: ProjectSetup): Project {
  const created = createProject(setup);
  projects.push(created);

  return created;
}

afterEach(() => {
  while (projects.length > 0) {
    projects.pop()?.dispose();
  }
});

const MODULES = {
  'src/a.ts': 'export const a = 1;\nexport const a2 = 11;\n',
  'src/b.ts': 'export const b = 2;\nexport const b2 = 22;\nexport default function d() {}\n',
  'src/side.ts': 'console.log("side effect");\n',
};

describe('reporting', () => {
  it('reports unsorted imports', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import { b } from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(a, b);\n',
      },
    });

    const diagnostic = p.onlyDiagnostic('entry.ts');
    expect(diagnostic.message).toBe('Imports are not organized.');
    expect(diagnostic.code).toBe('organize-imports(organize-imports)');
  });

  it('does not report a file that is already organized', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import { a } from "./src/a";\nimport { b } from "./src/b";\n\nconsole.log(a, b);\n',
      },
    });

    expect(p.diagnostics('entry.ts')).toEqual([]);
    expect(p.lint('entry.ts').status).toBe(0);
  });

  it('reports a range covering the imports, not the whole file', () => {
    const tail =
      'export function big() {\n  return "a long tail of code that must stay outside the range";\n}\n';
    const source = `import { b } from "./src/b";\nimport { a } from "./src/a";\n\n${tail}console.log(a, b);\n`;
    const p = project({ files: { ...MODULES, 'entry.ts': source } });

    const { offset, length } = p.onlyDiagnostic('entry.ts');

    expect(offset).toBe(0);
    expect(length).toBeLessThan(source.length / 2);
    // The reported span is the first import declaration.
    expect(source.slice(offset, offset + length)).toBe('import { b } from "./src/b";');
  });

  it('ignores files carrying the ignore marker', () => {
    const source =
      '// organize-imports-ignore\nimport { b } from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(a, b);\n';
    const p = project({ files: { ...MODULES, 'entry.ts': source } });

    expect(p.diagnostics('entry.ts')).toEqual([]);
    expect(p.lint('--fix-suggestions', 'entry.ts').status).toBe(0);
    expect(p.read('entry.ts')).toBe(source);
  });

  it('ignores non-TypeScript files', () => {
    const source =
      'import { b } from "./src/b.js";\nimport { a } from "./src/a.js";\n\nconsole.log(a, b);\n';
    const p = project({
      files: {
        'src/a.js': 'export const a = 1;\n',
        'src/b.js': 'export const b = 2;\n',
        'entry.js': source,
      },
    });

    expect(p.diagnostics('entry.js')).toEqual([]);
    expect(p.read('entry.js')).toBe(source);
  });
});

describe('fix tiering', () => {
  const UNSORTED = {
    ...MODULES,
    'entry.ts':
      'import { b } from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(a, b);\n',
  };

  it('mode "All" is a suggestion, so --fix alone leaves the file untouched', () => {
    const p = project({ files: UNSORTED });
    const before = p.read('entry.ts');

    expect(p.lint('--fix', 'entry.ts').status).toBe(1);
    expect(p.read('entry.ts')).toBe(before);
  });

  it('mode "All" applies under --fix-suggestions', () => {
    const p = project({ files: UNSORTED });

    expect(p.lint('--fix-suggestions', 'entry.ts').status).toBe(0);
    expect(p.read('entry.ts')).toBe(
      'import { a } from "./src/a";\nimport { b } from "./src/b";\n\nconsole.log(a, b);\n'
    );
  });

  it('mode "SortAndCombine" is a plain fix, applied by --fix', () => {
    const p = project({ files: UNSORTED, ruleOptions: { mode: 'SortAndCombine' } });

    expect(p.lint('--fix', 'entry.ts').status).toBe(0);
    expect(p.read('entry.ts')).toBe(
      'import { a } from "./src/a";\nimport { b } from "./src/b";\n\nconsole.log(a, b);\n'
    );
  });

  it('leaves the file organized after a fix, so a second run is clean', () => {
    const p = project({ files: UNSORTED });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.diagnostics('entry.ts')).toEqual([]);
  });
});

describe('modes', () => {
  it('mode "SortAndCombine" keeps unused imports', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import { b } from "./src/b";\nimport { a } from "./src/a";\nimport { b2 } from "./src/b";\n\nconsole.log(a, b);\n',
      },
      ruleOptions: { mode: 'SortAndCombine' },
    });

    p.lint('--fix', 'entry.ts');
    expect(p.read('entry.ts')).toBe(
      'import { a } from "./src/a";\nimport { b, b2 } from "./src/b";\n\nconsole.log(a, b);\n'
    );
  });

  it('mode "RemoveUnused" drops unused imports without reordering the rest', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import { b, b2 } from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(a, b);\n',
      },
      ruleOptions: { mode: 'RemoveUnused' },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    const result = p.read('entry.ts');

    expect(result).not.toContain('b2');
    // Not sorted: `./src/b` still comes first.
    expect(result.indexOf('./src/b')).toBeLessThan(result.indexOf('./src/a'));
  });

  it('mode "RemoveUnused" is a suggestion, not a plain fix', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts': 'import { b, b2 } from "./src/b";\n\nconsole.log(b);\n',
      },
      ruleOptions: { mode: 'RemoveUnused' },
    });
    const before = p.read('entry.ts');

    expect(p.lint('--fix', 'entry.ts').status).toBe(1);
    expect(p.read('entry.ts')).toBe(before);
  });
});

describe('organizing behaviour', () => {
  it('merges duplicate imports from one specifier', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import { b } from "./src/b";\nimport { b2 } from "./src/b";\n\nconsole.log(b, b2);\n',
      },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.read('entry.ts')).toBe('import { b, b2 } from "./src/b";\n\nconsole.log(b, b2);\n');
  });

  it('removes unused default and named imports', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import d, { b, b2 } from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(b);\n',
      },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.read('entry.ts')).toBe('import { b } from "./src/b";\n\nconsole.log(b);\n');
  });

  it('keeps side-effect-only imports', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import "./src/side";\nimport { b } from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(a, b);\n',
      },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    const result = p.read('entry.ts');

    expect(result).toContain('import "./src/side";');
    expect(result).toBe(
      'import { a } from "./src/a";\nimport { b } from "./src/b";\nimport "./src/side";\n\nconsole.log(a, b);\n'
    );
  });

  it("preserves each import's original quote style", () => {
    // `organizeImports` reprints declarations verbatim, so mixed quotes survive untouched.
    const p = project({
      files: {
        ...MODULES,
        'entry.ts': `import { b } from "./src/b";\nimport { a } from './src/a';\n\nconsole.log(a, b);\n`,
      },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.read('entry.ts')).toBe(
      `import { a } from './src/a';\nimport { b } from "./src/b";\n\nconsole.log(a, b);\n`
    );
  });

  it('reindents multi-line specifier lists with tabWidth', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import {\n  b,\n  b2,\n} from "./src/b";\nimport { a } from "./src/a";\n\nconsole.log(a, b, b2);\n',
      },
      ruleOptions: { useTabs: true },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.read('entry.ts')).toBe(
      'import { a } from "./src/a";\nimport {\n\tb,\n\tb2,\n} from "./src/b";\n\nconsole.log(a, b, b2);\n'
    );
  });

  it('keeps CRLF files free of mixed line endings', () => {
    const p = project({
      files: {
        ...MODULES,
        'entry.ts':
          'import {\r\n  b,\r\n  b2,\r\n} from "./src/b";\r\nimport { a } from "./src/a";\r\n\r\nconsole.log(a, b, b2);\r\n',
      },
    });

    p.lint('--fix-suggestions', 'entry.ts');
    const result = p.read('entry.ts');

    expect(result).toBe(
      'import { a } from "./src/a";\r\nimport {\r\n  b,\r\n  b2,\r\n} from "./src/b";\r\n\r\nconsole.log(a, b, b2);\r\n'
    );
    // A bare LF not preceded by CR would mean the rewritten region used the wrong newline.
    expect(/[^\r]\n/u.test(result)).toBe(false);
  });
});

describe('import type', () => {
  const TYPE_FILES = {
    'src/m.ts': 'export const val = 1;\nexport type T = string;\n',
    'entry.ts':
      'import { val } from "./src/m";\nimport type { T } from "./src/m";\n\nexport const x: T = "hi";\nconsole.log(val);\n',
  };
  const ORGANIZED =
    'import type { T } from "./src/m";\nimport { val } from "./src/m";\n\nexport const x: T = "hi";\nconsole.log(val);\n';

  it('keeps the type-only import separate without verbatimModuleSyntax', () => {
    const p = project({ files: TYPE_FILES, compilerOptions: { verbatimModuleSyntax: false } });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.read('entry.ts')).toBe(ORGANIZED);
  });

  it('keeps the type-only import separate with verbatimModuleSyntax', () => {
    const p = project({ files: TYPE_FILES, compilerOptions: { verbatimModuleSyntax: true } });

    p.lint('--fix-suggestions', 'entry.ts');
    expect(p.read('entry.ts')).toBe(ORGANIZED);
  });

  it('does not drop a type-only import that is still used', () => {
    const p = project({
      files: {
        'src/m.ts': 'export type T = string;\n',
        'entry.ts': 'import type { T } from "./src/m";\n\nexport const x: T = "hi";\n',
      },
      compilerOptions: { verbatimModuleSyntax: true },
    });

    expect(p.diagnostics('entry.ts')).toEqual([]);
  });
});

describe('tsx', () => {
  const TSX_FILES = {
    'src/helper.ts': 'export const helper = 1;\n',
    'react.d.ts': 'declare module "react" {\n  const React: any;\n  export default React;\n}\n',
    'entry.tsx':
      'import { helper } from "./src/helper";\nimport React from "react";\n\nexport const C = () => <div>{helper}</div>;\n',
  };

  it('keeps the React import under the classic JSX runtime, where JSX uses it', () => {
    const p = project({ files: TSX_FILES, compilerOptions: { jsx: 'react' } });

    p.lint('--fix-suggestions', 'entry.tsx');
    expect(p.read('entry.tsx')).toBe(
      'import React from "react";\nimport { helper } from "./src/helper";\n\nexport const C = () => <div>{helper}</div>;\n'
    );
  });

  it('removes the React import under the automatic JSX runtime, where it is unused', () => {
    const p = project({ files: TSX_FILES, compilerOptions: { jsx: 'react-jsx' } });

    p.lint('--fix-suggestions', 'entry.tsx');
    expect(p.read('entry.tsx')).toBe(
      'import { helper } from "./src/helper";\n\nexport const C = () => <div>{helper}</div>;\n'
    );
  });
});
