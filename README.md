# oxlint-plugin-organize-imports

Organize imports in [oxlint](https://oxc.rs/docs/guide/usage/linter), using the **TypeScript language service** — the same engine behind your editor's _Organize Imports_ command, and behind [`prettier-plugin-organize-imports`](https://github.com/simonhaenisch/prettier-plugin-organize-imports).

The ordering is not reimplemented here. Every decision about how imports sort, merge, and get dropped comes from `ts.LanguageService#organizeImports`, so the result matches your editor exactly.

## Why not just sort them?

Because tsserver's ordering is subtle, and reproducing it by hand goes wrong in ways that only show up later ([faker-js/faker#4022](https://github.com/faker-js/faker/pull/4022) is one such attempt). Delegating to the language service is the only way to get parity, so that is what this plugin does.

## Installation

```sh
pnpm add -D oxlint-plugin-organize-imports
```

`oxlint` and `typescript` are peer dependencies. **`typescript@latest` now resolves to 7.x, which will not work** — see [TypeScript version support](#typescript-version-support).

```sh
pnpm add -D oxlint typescript@^6
```

## Usage

Register the plugin under `jsPlugins` and turn the rule on:

```jsonc
// .oxlintrc.json
{
  "jsPlugins": ["oxlint-plugin-organize-imports"],
  "rules": {
    "organize-imports/organize-imports": "error",
  },
}
```

Then:

```sh
oxlint                    # report unorganized files
oxlint --fix-suggestions  # apply the fix (see Fixes vs. suggestions)
```

Only `.ts`, `.tsx`, `.mts`, and `.cts` files are handled. Everything else is skipped.

### Ignoring a file

Add the marker anywhere in the file — the same convention `prettier-plugin-organize-imports` uses:

```ts
// organize-imports-ignore
```

## Options

```jsonc
{
  "rules": {
    "organize-imports/organize-imports": [
      "error",
      {
        "mode": "All",
        "tabWidth": 2,
        "useTabs": false,
      },
    ],
  },
}
```

| Option     | Type                                          | Default | Description                                       |
| ---------- | --------------------------------------------- | ------- | ------------------------------------------------- |
| `mode`     | `"All" \| "SortAndCombine" \| "RemoveUnused"` | `"All"` | Which `ts.OrganizeImportsMode` to run. See below. |
| `tabWidth` | `number`                                      | `2`     | Indent width for multi-line specifier lists.      |
| `useTabs`  | `boolean`                                     | `false` | Indent multi-line specifier lists with tabs.      |

### Modes

| Mode             | Sorts | Merges duplicates | Removes unused |
| ---------------- | ----- | ----------------- | -------------- |
| `All` (default)  | ✅    | ✅                | ✅             |
| `SortAndCombine` | ✅    | ✅                | ❌             |
| `RemoveUnused`   | ❌    | ❌                | ✅             |

`tabWidth` and `useTabs` only take effect on import declarations that span multiple lines; single-line imports are reprinted as-is.

Quote style is **always preserved**. `organizeImports` reprints existing declarations verbatim, so it never rewrites module-specifier quotes — even mixed quotes survive untouched. There is deliberately no `quotePreference` option, because the language service ignores it for this operation.

## Fixes vs. suggestions

The rule chooses its fix tier based on whether the selected mode can change runtime behaviour:

| Mode                  | Emitted as   | Applied by                 |
| --------------------- | ------------ | -------------------------- |
| `SortAndCombine`      | `fix`        | `oxlint --fix`             |
| `All`, `RemoveUnused` | `suggestion` | `oxlint --fix-suggestions` |

`SortAndCombine` only reorders and merges, which preserves behaviour, so it is safe to apply automatically. The other two modes **delete imports**, and deleting an import is not always behaviour-preserving — a module's side effects, ambient declarations, and JSX factory usage can all make an import that looks unused matter. Those are gated behind `--fix-suggestions`, which oxlint documents as "may change program behavior".

> [!NOTE]
> Oxlint has a third, more restrictive tier (`--fix-dangerously`), but as of oxlint `1.82` JS plugins have no way to mark a fix dangerous — the `Diagnostic` type exposes only `fix` and `suggest`. `suggestion` is the closest available fit. If oxlint gains fix kinds for JS plugins, this should move.

### Reported range

The rule reports on the **first import declaration**, and its fix replaces only the region TypeScript actually changed — never the whole file. That keeps the diagnostic readable and keeps the fix from colliding with unrelated rules elsewhere in the file.

## TypeScript version support

**Supported: `typescript@^5 || ^6`.**

TypeScript 7 (the Go port) no longer ships the JavaScript language service. Its package exports are a version stub plus `typescript/unstable/{sync,async,ast,proto,fs}`; the sync API is compiler and checker only, and the string `organizeImports` does not appear anywhere in the published `dist`. In TypeScript 7 the operation exists only in the tsgo LSP, as the `source.organizeImports` code action. (`organize-imports-cli` pins `typescript: ^6` for the same reason.)

Importing `typescript@7` succeeds and even reports a `version`, so the plugin probes for the language service API itself and fails with an explicit error rather than a confusing `undefined is not a function`:

```
oxlint-plugin-organize-imports requires a TypeScript with the JavaScript language service,
but typescript@7.0.2 does not provide one.
```

Note that `typescript@latest` resolves to 7.x, so the version has to be pinned explicitly.

A TypeScript 7 backend would need a **synchronous** LSP client, because oxlint's JS plugin rule callbacks are synchronous. [`corsa-bind`](https://github.com/microsoft/typescript-go)'s `SyncMsgpackStdio` is the candidate transport. That is a v2 project, not a patch.

## How this differs from oxfmt's `sortImports`

[oxfmt](https://oxc.rs/docs/guide/usage/formatter) can sort imports via `sortImports` (spelled `experimentalSortImports` in older versions; it is off by default and uses an algorithm similar to [`eslint-plugin-perfectionist/sort-imports`](https://perfectionist.dev/rules/sort-imports)). But it is **non-destructive by design** and will never remove an unused import or merge two imports of the same module — that is a deliberate formatter constraint, not a missing feature.

|                                   | `oxfmt` `sortImports`            | this plugin                 |
| --------------------------------- | -------------------------------- | --------------------------- |
| Sorts imports                     | ✅                               | ✅                          |
| Merges duplicate specifiers       | ❌                               | ✅                          |
| Removes unused imports            | ❌                               | ✅                          |
| Ordering source                   | oxfmt's own config-driven sorter | TypeScript language service |
| Matches editor "Organize Imports" | ❌                               | ✅                          |
| Needs type information            | ❌                               | ✅ (single-file program)    |

If all you want is deterministic import order and you do not need editor parity, `oxfmt` is faster and has no TypeScript dependency. Use this plugin when you want what the editor does — in particular when migrating off `prettier-plugin-organize-imports`.

Running both is not recommended: they will disagree about ordering.

Oxlint itself does not ship this: [oxc-project/oxc#26521](https://github.com/oxc-project/oxc/issues/26521) was closed as not planned, with the recommendation to write a third-party JS plugin. This is that plugin.

## How it works

- One `ts.LanguageService` is created per discovered `tsconfig.json` in `createOnce`, and reused for every file in the run.
- The `LanguageServiceHost` reports only the **current** file from `getScriptFileNames`, so TypeScript builds a single-file program. `organizeImports` needs the binder and the local checker, not a project-wide type graph. This is the same trick `prettier-plugin-organize-imports` and `organize-imports-cli` use, and it is what keeps the plugin fast enough to run per-file inside a linter.
- Your `tsconfig.json` is honoured. This matters more than it sounds: under `"jsx": "react"` a `React` import is used by the JSX factory and is kept, while under `"jsx": "react-jsx"` the same import is genuinely unused and gets removed.
- The scattered text changes TypeScript returns are collapsed into a single ranged replacement.
- Line endings are detected from the file, so CRLF files do not come back with mixed endings.

## Limitations

- **TypeScript only.** Vue, Svelte, and Angular templates are out of scope: oxlint JS plugins do not support custom parsers yet.
- **TypeScript 7 is not supported.** See above.
- The plugin shells out to the TypeScript language service per file, so it is meaningfully slower than a native oxlint rule. It is still a single-file program per check, not a full project build.

## License

[MIT](./LICENSE)
