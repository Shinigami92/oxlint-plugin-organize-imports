import type { ESTree, Fixer } from '@oxlint/plugins';
import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { selectBackend } from './backend';
import { organizeFile, resolveSettings } from './core';
import { isOrganizable } from './eligibility';
import { findTsconfig } from './tsconfig';
import type { RuleOptions, Settings } from './types';

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
    const backend = selectBackend();
    // Now, not on the first file: this is the last moment the process is small enough for the
    // language-server backend to spawn a child on Linux. See `Backend.prepare`.
    backend.prepare();
    const tsconfigCache = new Map<string, string | null>();

    let settings: Settings;

    return {
      before(): boolean {
        const text = context.sourceCode.text;
        if (!isOrganizable(context.filename, text)) {
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
          tsconfigPath = findTsconfig(dir);
          tsconfigCache.set(dir, tsconfigPath);
        }

        const edit = organizeFile(backend, tsconfigPath, filename, text, settings);
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
