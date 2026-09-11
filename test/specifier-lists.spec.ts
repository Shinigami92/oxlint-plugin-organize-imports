import { describe, expect, it } from 'vitest';
import { namedSpecifierLists } from '../src/specifier-lists';

/**
 * The scanner stands in for a parser on TypeScript 7, so its cases are the shapes a real
 * import or export declaration can take — and the look-alikes it must refuse.
 */
describe('namedSpecifierLists', () => {
  it('finds a single-line import list', () => {
    const text = 'import { a, b } from "./m";\n';

    expect(namedSpecifierLists(text)).toEqual([
      { end: text.indexOf(' }'), isMultiLine: false, hasTrailingComma: false },
    ]);
  });

  it('reports a multi-line list with a trailing comma, ending just past the comma', () => {
    const text = 'import {\n  a,\n  b,\n} from "./m";\n';

    expect(namedSpecifierLists(text)).toEqual([
      { end: text.indexOf('b,') + 2, isMultiLine: true, hasTrailingComma: true },
    ]);
  });

  it('reports a multi-line list without one, ending just past the last specifier', () => {
    const text = 'export {\n  a,\n  b\n} from "./m";\n';

    expect(namedSpecifierLists(text)).toEqual([
      { end: text.indexOf('b\n') + 1, isMultiLine: true, hasTrailingComma: false },
    ]);
  });

  it('treats CRLF as a line break', () => {
    expect(namedSpecifierLists('import {\r\n  a,\r\n} from "./m";\r\n')[0]?.isMultiLine).toBe(true);
  });

  it.each([
    ['a type-only import', 'import type { A } from "./m";'],
    ['a type-only export', 'export type { A } from "./m";'],
    ['a default binding before the list', 'import d, { a } from "./m";'],
    ['a type-only default binding before the list', 'import type d, { a } from "./m";'],
    ['a re-export with import attributes', 'export { a } from "./m.json" with { type: "json" };'],
    ['an aliased specifier', 'import { a as b } from "./m";'],
    ['a string-named specifier', 'import { "kebab-name" as k } from "./m";'],
    ['a list without a module specifier', 'export { a, b };'],
  ])('finds exactly one list in %s', (_label, text) => {
    expect(namedSpecifierLists(text)).toHaveLength(1);
  });

  it.each([
    ['a namespace import', 'import * as ns from "./m";'],
    ['a default-only import', 'import d from "./m";'],
    ['a side-effect import', 'import "./m";'],
    ['a default import with attributes', 'import data from "./m.json" with { type: "json" };'],
    ['a star re-export', 'export * from "./m";'],
    ['a type-only star re-export', 'export type * from "./m";'],
    ['a destructuring export', 'export const { a, b } = o;'],
    ['a default object export', 'export default { a: 1 };'],
    ['an exported type alias', 'export type X = {\n  a: 1;\n};'],
    ['an exported interface', 'export interface X {\n  a: 1;\n}'],
    ['an exported function', 'export function f() {\n  return { a: 1 };\n}'],
    ['an exported class', 'export class C {}'],
    ['an exported enum', 'export enum E {\n  A,\n}'],
    ['an import-equals', 'import x = require("./m");'],
    ['an export-equals', 'export = { a: 1 };'],
    ['a dynamic import', 'const m = import("./m");'],
    ['an empty list', 'import {} from "./m";'],
    ['an unterminated list', 'import { a, b'],
    ['an identifier that merely starts with the keyword', 'importantThing({ a });'],
  ])('ignores %s', (_label, text) => {
    expect(namedSpecifierLists(text)).toEqual([]);
  });

  it('skips braces and quotes inside comments', () => {
    const text = 'import { // { not a list\n  a, /* } "quote */\n  b,\n} from "./m";\n';

    expect(namedSpecifierLists(text)).toEqual([
      { end: text.indexOf('b,') + 2, isMultiLine: true, hasTrailingComma: true },
    ]);
  });

  it('skips braces inside string literals between declarations', () => {
    const text = 'import { a } from "./{m}";\nexport { b } from \'./}\';\n';

    expect(namedSpecifierLists(text)).toHaveLength(2);
  });

  it('is not derailed by quotes in regex literals or JSX text between declarations', () => {
    const text = [
      'import { a } from "./a";',
      "const apostrophe = /'/u;",
      "const el = <p>Don't {a}</p>;",
      'export {',
      '  b,',
      '} from "./b";',
      '',
    ].join('\n');

    expect(namedSpecifierLists(text)).toHaveLength(2);
    expect(namedSpecifierLists(text)[1]).toMatchObject({
      isMultiLine: true,
      hasTrailingComma: true,
    });
  });

  it('only recognises a declaration that starts its line', () => {
    // The price of never tokenizing the code between declarations; see the module comment.
    expect(namedSpecifierLists('const x = 1; export { x };\n')).toEqual([]);
    expect(namedSpecifierLists('  export { x };\n')).toHaveLength(1);
  });

  it('ignores a commented-out declaration', () => {
    expect(namedSpecifierLists('// import {\n//   a,\n// } from "./m";\n')).toEqual([]);
  });

  it('lets one declaration span several lines without re-reading them', () => {
    const text = 'export {\n  a,\n  b,\n} from "./m";\nexport { c } from "./c";\n';

    expect(namedSpecifierLists(text)).toHaveLength(2);
  });

  it('ends a list before a comment that follows its last specifier', () => {
    const text = 'export {\n  a // last\n} from "./m";\n';

    expect(namedSpecifierLists(text)).toEqual([
      { end: text.indexOf('a //') + 1, isMultiLine: true, hasTrailingComma: false },
    ]);
  });

  it('reports every declaration in order', () => {
    const text =
      'import { a } from "./a";\nexport {\n  b,\n} from "./b";\nexport { c } from "./c";\n';

    expect(namedSpecifierLists(text).map((list) => list.isMultiLine)).toEqual([false, true, false]);
  });
});
