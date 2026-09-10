import { describe, expect, it } from 'vitest';
import { IGNORE_MARKER, isOrganizable } from '../src/eligibility';

describe('isOrganizable', () => {
  it.each(['entry.ts', 'entry.tsx', 'entry.mts', 'entry.cts', 'entry.d.ts', '/abs/path/x.ts'])(
    'accepts %s',
    (filename) => {
      expect(isOrganizable(filename, 'const a = 1;\n')).toBe(true);
    }
  );

  it.each([
    'entry.js',
    'entry.jsx',
    'entry.mjs',
    'entry.cjs',
    'entry.json',
    'entry.vue',
    'entry.ts.snap',
    'ts',
  ])('rejects %s', (filename) => {
    expect(isOrganizable(filename, 'const a = 1;\n')).toBe(false);
  });

  it('rejects a file carrying the ignore marker', () => {
    expect(isOrganizable('entry.ts', `${IGNORE_MARKER}\nimport { a } from "./a";\n`)).toBe(false);
  });

  it('matches the marker anywhere, not just on the first line', () => {
    expect(isOrganizable('entry.ts', `const doc = "${IGNORE_MARKER}";\n`)).toBe(false);
  });
});
