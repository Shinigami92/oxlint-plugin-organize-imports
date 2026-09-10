import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import type { ESTree, Fixer } from '@oxlint/plugins';
import ts from 'typescript';
import { createServiceCache, organizeFile, resolveSettings } from './core';
import type { RuleOptions, Settings } from './types';

/** Files containing this marker are left alone (same convention as `prettier-plugin-organize-imports`). */
const IGNORE_MARKER = '// organize-imports-ignore';

/** The language service only handles TypeScript here; oxlint has no custom-parser support yet. */
const TS_FILE = /\.(?:m|c)?tsx?$/u;

export const organizeImportsRule = defineRule({
  meta: {
    type: 'layout',
    fixable: 'code',
    hasSuggestions: true,
    docs: {
      description:
        "Keep imports organized the way the TypeScript language service would (the editor's 'Organize Imports').",
    },
    messages: {
      unorganized: 'Imports are not organized.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          mode: { enum: ['All', 'SortAndCombine', 'RemoveUnused'] },
          tabWidth: { type: 'number' },
          useTabs: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
  },

  createOnce(context) {
    const getService = createServiceCache();
    const tsconfigCache = new Map<string, string | null>();

    let settings: Settings;

    return {
      before(): boolean {
        if (!TS_FILE.test(context.filename)) {
          return false;
        }

        const text = context.sourceCode.text;
        if (text.includes(IGNORE_MARKER)) {
          return false;
        }

        // `createOnce` rules must read options here rather than in `createOnce` itself:
        // per-file options are attached to the context after the rule is initialized.
        const [rawOptions] = context.options;
        settings = resolveSettings((rawOptions ?? {}) as RuleOptions, text);

        return true;
      },

      Program(node: ESTree.Program) {
        const filename = path.resolve(context.filename);
        const text = context.sourceCode.text;
        const dir = path.dirname(filename);

        let tsconfigPath = tsconfigCache.get(dir);
        if (tsconfigPath === undefined) {
          tsconfigPath = ts.findConfigFile(dir, ts.sys.fileExists) ?? null;
          tsconfigCache.set(dir, tsconfigPath);
        }

        const edit = organizeFile(getService, tsconfigPath, filename, text, settings);
        if (edit === null) {
          return;
        }

        const { start, end, replacement } = edit;

        // Point at the first import rather than the whole Program, so the diagnostic lands on
        // the import block instead of underlining the entire file.
        const target =
          node.body.find((statement) => statement.type === 'ImportDeclaration') ?? node;
        const fix = (fixer: Fixer) => fixer.replaceTextRange([start, end], replacement);

        // Sorting and merging is behaviour-preserving, so it can be a plain fix. Removing
        // unused imports can change behaviour (a module's side effects, ambient declarations,
        // JSX factories), so it is offered as a suggestion instead, applied only with
        // `oxlint --fix-suggestions`.
        context.report(
          settings.destructive
            ? {
                node: target,
                messageId: 'unorganized',
                suggest: [{ desc: 'Organize imports', fix }],
              }
            : { node: target, messageId: 'unorganized', fix }
        );
      },
    };
  },
});
