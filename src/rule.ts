import type { Context, ESTree, Fixer, VisitorWithHooks } from '@oxlint/plugins';
import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { selectBackend } from './backend';
import { organizeFile, resolveSettings } from './core';
import { isOrganizable } from './eligibility';
import { findTsconfig } from './tsconfig';
import type { Backend, Edit, RuleOptions, Settings } from './types';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How this rule tells the user something went wrong.
 *
 * Not `context.report`: a diagnostic needs a file, and the failures below are either about no
 * file in particular (`createOnce`) or about all of them at once (a backend that has stopped
 * answering). Both are said once per run, on stderr, and then the run carries on.
 */
function warn(message: string): void {
  console.error(`oxlint-plugin-organize-imports: ${message}`);
}

/**
 * A ready backend, or nothing at all if it could not be brought up.
 *
 * oxlint does not contain a throw from `createOnce` the way it contains one from a visitor:
 * it surfaces as `Failed to parse oxlint configuration file` and *nothing* gets linted — not
 * one file, not by any other plugin, not by the built-in rules. Selecting and preparing a
 * backend reaches well outside this process (a platform package that is not installed, a
 * `tsgo` that will not start, a `fork` the kernel refuses), so none of that may escape. The
 * rule sits the run out instead, and every other rule still does its job.
 */
function startBackend(select: () => Backend): Backend | undefined {
  let started: Backend | undefined;
  try {
    started = select();
    // Now, not on the first file: this is the last moment the process is small enough for the
    // language-server backend to spawn a child on Linux. See `Backend.prepare`.
    started.prepare();

    return started;
  } catch (error) {
    warn(
      `could not start: ${messageOf(error)}\nThe organize-imports rule is skipped for this run; every other rule is unaffected.`
    );
  }

  try {
    // It may have got as far as holding a worker thread before it gave up.
    started?.dispose();
  } catch (error) {
    warn(`could not release the backend that failed to start: ${messageOf(error)}`);
  }

  return undefined;
}

/**
 * The rule's `createOnce`, with the backend chosen by the caller.
 *
 * @param select Only tests pass anything but {@link selectBackend}, to reach the failure
 *   paths without breaking the TypeScript the suite itself runs on.
 */
export function createOrganizeImports(
  context: Context,
  select: () => Backend = selectBackend
): VisitorWithHooks {
  const backend = startBackend(select);
  const tsconfigCache = new Map<string, string | null>();

  let settings: Settings;
  let reportedFailure = false;

  return {
    before(): boolean {
      if (backend === undefined) {
        return false;
      }

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
      /* v8 ignore next 3 -- `before()` already returned false for every file. */
      if (backend === undefined) {
        return;
      }

      const filename = path.resolve(context.filename);
      const text = context.sourceCode.text;
      const dir = path.dirname(filename);

      let tsconfigPath = tsconfigCache.get(dir);
      if (tsconfigPath === undefined) {
        tsconfigPath = findTsconfig(dir);
        tsconfigCache.set(dir, tsconfigPath);
      }

      let edit: Edit | null;
      try {
        edit = organizeFile(backend, tsconfigPath, filename, text, settings);
      } catch (error) {
        // A throw here is contained by oxlint to this one file, but it is reported as
        // `Error running JS plugin` with a stack trace — and a backend that has given up
        // fails identically for every file that follows, so that is one stack trace per file
        // of a repository. Say it once, in a sentence, and leave the remaining files
        // unorganized rather than unlinted.
        if (!reportedFailure) {
          reportedFailure = true;
          warn(
            `could not organize ${filename}: ${messageOf(error)}\nAny further failure in this run is not reported.`
          );
        }

        return;
      }

      if (edit === null) {
        return;
      }

      const { start, end, replacement } = edit;

      // Point at the first import rather than the whole Program, so the diagnostic lands on
      // the import block instead of underlining the entire file.
      const target = node.body.find((statement) => statement.type === 'ImportDeclaration') ?? node;
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
}

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
    return createOrganizeImports(context);
  },
});
