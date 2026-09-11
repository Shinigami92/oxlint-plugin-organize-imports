import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createLspBackend,
  installedTypescriptPackage,
  lineStarts,
  offsetAt,
  resolveTsgoExecutable,
} from '../src/lsp-backend';
import { LSP, TYPESCRIPT_7_PACKAGE } from './backends';
import { organizeText } from './in-process';

/**
 * What is specific to the language-server backend. Everything it shares with the language
 * service — sorting, modes, formatting, tsconfig handling — runs against both in `core.spec.ts`.
 */
describe('resolveTsgoExecutable', () => {
  it('finds the platform binary next to a TypeScript 7 install', () => {
    const executable = resolveTsgoExecutable(TYPESCRIPT_7_PACKAGE);

    expect(executable).toMatch(/[\\/]lib[\\/]tsc(?:\.exe)?$/u);
    expect(fs.existsSync(executable)).toBe(true);
  });

  it('names the platform package when a TypeScript has no binary beside it', () => {
    // Pretend to be a platform TypeScript 7 does not ship for. (Resolving from a directory
    // that has no `node_modules` is not enough: vitest routes `createRequire` through Vite's
    // resolver, which falls back to the project root and finds the real binary.)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });

    try {
      expect(() => resolveTsgoExecutable(TYPESCRIPT_7_PACKAGE)).toThrow(
        new RegExp(`'@typescript/typescript-sunos-${process.arch}' is not installed next to `, 'u')
      );
    } finally {
      Object.defineProperty(process, 'platform', platform as PropertyDescriptor);
    }
  });

  it('resolves the installed TypeScript by default', () => {
    expect(installedTypescriptPackage()).toMatch(/[\\/]typescript[\\/]package\.json$/u);
  });
});

describe('position mapping', () => {
  it('counts LF, CRLF and a lone CR as line breaks', () => {
    expect(lineStarts('a\nbb\r\nccc\rd')).toEqual([0, 2, 6, 10]);
  });

  it('starts with a single line for empty text', () => {
    expect(lineStarts('')).toEqual([0]);
  });

  it('maps a position onto an offset', () => {
    const text = 'ab\ncd\n';

    expect(offsetAt(lineStarts(text), text, { line: 1, character: 1 })).toBe(4);
  });

  it('clamps a line past the end to the end of the text', () => {
    const text = 'ab\ncd';

    expect(offsetAt(lineStarts(text), text, { line: 9, character: 0 })).toBe(text.length);
  });

  it('clamps a column past the end to the end of the text', () => {
    const text = 'ab';

    expect(offsetAt(lineStarts(text), text, { line: 0, character: 99 })).toBe(text.length);
  });
});

describe('the language-server backend', () => {
  const backend = LSP.create();

  afterAll(() => {
    backend.dispose();
  });

  const multiLine =
    'import {\n  b,\n  b2,\n} from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b, b2);\n';

  it('reconfigures the server when the indentation options change between files', () => {
    expect(organizeText(multiLine, { backend })).toContain('\n  b,\n');
    expect(organizeText(multiLine, { backend, options: { tabWidth: 4 } })).toContain('\n    b,\n');
    expect(organizeText(multiLine, { backend, options: { useTabs: true } })).toContain('\n\tb,\n');
    // Back to the defaults, so the change is not just a one-way ratchet.
    expect(organizeText(multiLine, { backend })).toContain('\n  b,\n');
  });

  it('starts a fresh server after being disposed', () => {
    const disposable = LSP.create();
    const text = 'import { b } from "./b";\nimport { a } from "./a";\n\nconsole.log(a, b);\n';
    const organized = 'import { a } from "./a";\nimport { b } from "./b";\n\nconsole.log(a, b);\n';

    try {
      expect(organizeText(text, { backend: disposable })).toBe(organized);
      disposable.dispose();
      expect(organizeText(text, { backend: disposable })).toBe(organized);
    } finally {
      disposable.dispose();
    }
  });

  it('survives being disposed before it ever started', () => {
    expect(() => {
      LSP.create().dispose();
    }).not.toThrow();
  });

  it('reports a server that cannot be started', () => {
    const broken = createLspBackend({ executable: '/no/such/tsgo' });

    try {
      expect(() => organizeText(multiLine, { backend: broken })).toThrow(/could not start/u);
    } finally {
      broken.dispose();
    }
  });
});
