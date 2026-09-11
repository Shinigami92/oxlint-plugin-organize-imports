/**
 * Every `{ ... }` specifier list of an import or export declaration in `text`.
 *
 * This is the one place the plugin needs a parse of its own: `restoreTrailingCommas` has to
 * know where a multi-line list ends and whether it already carries a trailing comma.
 * TypeScript 5/6 could answer that with `ts.createSourceFile`, but TypeScript 7 ships no
 * parser to JavaScript, so both backends share this hand-rolled scan instead.
 *
 * What makes a scanner this small safe is that it never tokenizes arbitrary code. A
 * declaration is only recognised where `import` or `export` opens a line, and only the
 * declaration itself is then read closely — strings and comments are the only things that can
 * hide a brace in one, and regular-expression literals and JSX text, which defeat every
 * lightweight JavaScript tokenizer, cannot appear in one at all. Everything between
 * declarations is skipped a line at a time without being looked at.
 *
 * The trade is that a declaration which does not start its line is invisible, and that a
 * line inside a block comment or template literal which happens to start with `export {` is
 * taken at face value. Both are rare in practice, and either way the only consequence is a
 * trailing comma judged by a slightly different sample of the file.
 */
export interface SpecifierList {
  /**
   * Offset just past the last specifier, i.e. where a trailing comma would go. When the list
   * already has one, this is just past that comma, as TypeScript's `NodeArray.end` is.
   */
  readonly end: number;
  readonly isMultiLine: boolean;
  readonly hasTrailingComma: boolean;
}

/**
 * Words that can follow `import`/`export` and rule out a specifier list, so `export const
 * { a } = o`, `export default { a: 1 }` and `import x from './x'` are not mistaken for one.
 */
const NOT_A_BINDING = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'class',
  'const',
  'declare',
  'default',
  'enum',
  'export',
  'from',
  'function',
  'import',
  'interface',
  'let',
  'module',
  'namespace',
  'using',
  'var',
]);

const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200C\u200D]/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
const WHITESPACE = /\s/u;
const LINE_START_KEYWORD =
  /^[^\S\n\r\u2028\u2029]*(import|export)(?![\p{ID_Continue}$\u200C\u200D])/gmu;

function isQuote(char: string): boolean {
  return char === '"' || char === "'" || char === '`';
}

/** Index just past the whitespace and comments starting at `from`. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const char = text[i] as string;
    if (WHITESPACE.test(char)) {
      i++;
    } else if (char === '/' && text[i + 1] === '/') {
      const lineEnd = text.slice(i).search(LINE_BREAK);
      i = lineEnd === -1 ? text.length : i + lineEnd;
    } else if (char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else {
      break;
    }
  }

  return i;
}

/**
 * Index just past the string literal whose opening quote sits at `from`. An unterminated
 * single- or double-quoted string ends at the line break, to keep the damage local.
 */
function skipString(text: string, from: number): number {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '\\') {
      i += 2;
    } else if (char === quote) {
      return i + 1;
    } else if (quote !== '`' && LINE_BREAK.test(char)) {
      return i;
    } else {
      i++;
    }
  }

  return text.length;
}

/** Index just past the identifier starting at `from`. */
function skipWord(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length && IDENTIFIER_PART.test(text[i] as string)) {
    i++;
  }

  return i;
}

/**
 * Scan the `{ ... }` opening at `open` and record it if it holds at least one specifier.
 *
 * @returns Index just past the closing brace.
 */
function scanList(text: string, open: number, lists: SpecifierList[]): number {
  let i = open + 1;
  let lastEnd = -1;
  let lastWasComma = false;

  for (;;) {
    i = skipTrivia(text, i);
    const char = text[i];
    if (char === undefined) {
      return i;
    }
    if (char === '}') {
      break;
    }

    if (isQuote(char)) {
      i = skipString(text, i);
    } else if (IDENTIFIER_START.test(char)) {
      i = skipWord(text, i);
    } else {
      i++;
    }

    lastEnd = i;
    lastWasComma = char === ',';
  }

  if (lastEnd !== -1) {
    lists.push({
      end: lastEnd,
      isMultiLine: LINE_BREAK.test(text.slice(open, i)),
      hasTrailingComma: lastWasComma,
    });
  }

  return i + 1;
}

/**
 * Having just read `import` or `export`, look for the named list that may follow.
 *
 * The grammar between the keyword and the brace is tiny: an optional `type`, an optional
 * default binding, a comma. Anything else — `*`, a string, `=`, `(`, a reserved word —
 * means this declaration has no list, or is not a declaration at all.
 *
 * @returns Index to resume scanning from.
 */
function scanDeclaration(text: string, from: number, lists: SpecifierList[]): number {
  let i = from;
  let sawType = false;
  let sawBinding = false;

  for (;;) {
    i = skipTrivia(text, i);
    const char = text[i];
    if (char === undefined) {
      return i;
    }
    if (char === '{') {
      return scanList(text, i, lists);
    }
    if (char === ',' && (sawBinding || sawType)) {
      sawBinding = true;
      i++;
      continue;
    }
    if (!IDENTIFIER_START.test(char)) {
      return i;
    }

    const end = skipWord(text, i);
    const word = text.slice(i, end);
    if (word === 'type' && !sawType && !sawBinding) {
      sawType = true;
    } else if (sawBinding || NOT_A_BINDING.has(word)) {
      return end;
    } else {
      sawBinding = true;
    }
    i = end;
  }
}

export function namedSpecifierLists(text: string): SpecifierList[] {
  const lists: SpecifierList[] = [];
  let resumeAt = 0;

  for (const match of text.matchAll(LINE_START_KEYWORD)) {
    // A declaration may have run across the lines the previous one spanned.
    if (match.index < resumeAt) {
      continue;
    }

    resumeAt = scanDeclaration(text, match.index + match[0].length, lists);
  }

  return lists;
}
