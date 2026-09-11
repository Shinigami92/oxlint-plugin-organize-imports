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

Re-`export` declarations (`export { … } from '…'`) are sorted and merged as well — that is part of what the editor command does, not an extra.

### Ignoring a file

Add the marker anywhere in the file — the same convention `prettier-plugin-organize-imports` uses:

```ts
// organize-imports-ignore
```

The marker is matched anywhere in the file, including inside strings and comments — the same loose check `prettier-plugin-organize-imports` uses. A file that merely _mentions_ it opts itself out.

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

Trailing commas are preserved too, but that one needs help: TypeScript reprints _export_ declarations through its emitter, which never emits a trailing comma (import declarations are left byte-for-byte alone). The plugin restores the file's own convention afterwards, so a multi-line list written with a trailing comma keeps it. Without that, every already-sorted file using `trailingComma: "es5"` would report forever and fight the formatter.

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

**Supported: `typescript@^5 || ^6 || ^7`.** The plugin drives whichever one your project has installed; nothing to configure.

| TypeScript | How `organizeImports` runs                                                          |
| ---------- | ----------------------------------------------------------------------------------- |
| 5, 6       | In-process, through `ts.createLanguageService` — the JavaScript language service.   |
| 7          | Through the `tsgo` language server that ships with `typescript@7`, driven over LSP. |

TypeScript 7 (the Go port) no longer ships the JavaScript language service. Its package exports are a version stub plus `typescript/unstable/*`, and `organizeImports` survives only inside the `tsgo` executable, as the `source.organizeImports` family of code actions — which is exactly what an editor's "Organize Imports" asks for. So on 7 the plugin does what VS Code does: it starts `tsgo --lsp` from the `@typescript/typescript-<platform>` package that `typescript@7` installs, opens each file, requests the code action, and applies the edits. There is no editor involved and nothing else to install; it works the same in CI.

oxlint's rule callbacks are synchronous and a language server is not, so the server is driven from a worker thread with an ordinary event loop while the linting thread waits on `Atomics.wait` — the same trick `synckit` uses. One server is started per lint run, on the first TypeScript file, and each file is a `didOpen` / `codeAction` / `didClose` round trip. The server exits with the process.

Behaviour is the same on both: the same sorting, merging and removal, the same `tsconfig.json` handling, the same trailing-comma restoration, the same line endings. A sweep of faker's 3 368 source files with scrambled imports produced identical output from both backends, at a different price:

| faker `src/`, scrambled imports, Apple M-series | TypeScript 6.0.3 language service | TypeScript 7.0.2 language server |
| ----------------------------------------------- | --------------------------------: | -------------------------------: |
| First file (includes startup / project load)    |                             59 ms |                           213 ms |
| Per file, 187 of 3 368 needing changes          |                           0.42 ms |                          2.64 ms |
| Per file, nothing to change                     |                           0.42 ms |                          0.46 ms |

The language server is slower on a file that needs changes because it checks that file against its real project rather than a `noResolve` single-file program. Both are far below what a type-aware lint of the same file costs. Three things differ in output, all by construction:

- **Formatting of a rewritten export list.** `tsgo`'s printer puts each specifier of a multi-line `export { … }` on its own line; TypeScript 5/6 keeps them on one. Both are what the respective editor would produce.
- **Project scope.** The language service builds a single-file program with the nearest `tsconfig.json`'s options. The language server loads the file's real project, so the first file of a run pays for that (a few hundred milliseconds on a 3 000-file project), and a file that no `tsconfig.json` includes gets default compiler options rather than the nearest tsconfig's — as it would in the editor.
- **Unparseable files.** The language service gives up; the language server organizes what it could parse. Moot under oxlint, which never runs a rule on a file its own parser rejected.

If `typescript@7` is installed but its platform binary is not — an unsupported platform, or optional dependencies skipped — the plugin fails with a message naming the missing `@typescript/typescript-<platform>-<arch>` package. A TypeScript older than 5 fails with a message naming the supported range.

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

Running both is not recommended: they will disagree about ordering, and because each one "fixes" the other's output they can ping-pong indefinitely. In practice the two agree far more often than you would expect — a sweep of faker's whole source tree against its `sortImports` group config found no disagreements at all. But at least one case diverges permanently: a bare index import (`from '.'`) goes last for oxfmt, which treats `index` as its own trailing group, and first for tsserver, which just sorts `'.'` lexicographically among the relative specifiers. If your codebase uses bare index imports, pick one tool.

(Thanks to the faker maintainers' session for stress-testing this — the trailing-comma bug and the index-import case both came out of a real run against faker.)

Oxlint itself does not ship this: [oxc-project/oxc#26521](https://github.com/oxc-project/oxc/issues/26521) was closed as not planned, with the recommendation to write a third-party JS plugin. This is that plugin.

## How it works

- The backend is picked once, when the rule is created: the language service if the installed `typescript` has one, the `tsgo` language server if it is 7. See [TypeScript version support](#typescript-version-support).
- **On TypeScript 5/6**, one `ts.LanguageService` is created per discovered `tsconfig.json` and reused for every file in the run. The `LanguageServiceHost` reports only the **current** file from `getScriptFileNames`, so TypeScript builds a single-file program: `organizeImports` needs the binder and the local checker, not a project-wide type graph. This is the same trick `prettier-plugin-organize-imports` and `organize-imports-cli` use. The program is built with `noResolve`, because `organizeImports` decides what is unused from the file's _local_ reference graph and never needs the types behind a module specifier — worth well over an order of magnitude, for identical output; see [BENCHMARKS.md](./BENCHMARKS.md).
- **On TypeScript 7**, one `tsgo --lsp` process is started per run and each file is a `didOpen` / `codeAction` / `didClose` round trip, made synchronous through a worker thread. The server discovers the file's `tsconfig.json` itself.
- Your `tsconfig.json` is honoured either way. This matters more than it sounds: under `"jsx": "react"` a `React` import is used by the JSX factory and is kept, while under `"jsx": "react-jsx"` the same import is genuinely unused and gets removed.
- The scattered text changes TypeScript returns are collapsed into a single ranged replacement.
- Line endings are detected from the file, so CRLF files do not come back with mixed endings.

## Interaction with other rules and tools

This rule rewrites the whole import block, so it overlaps with anything else that sorts,
merges, or prunes imports. Two different kinds of overlap, with different fixes.

### Turn these off — they impose a different order

| Tool                             | Why                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| oxfmt `sortImports`              | A different ordering algorithm. See [above](#how-this-differs-from-oxfmts-sortimports).                                              |
| `sort-imports` (default options) | Orders by _member syntax_ first (`none`, `all`, `multiple`, `single`), where the language service orders purely by module specifier. |

`sort-imports` is worth spelling out, because a file this rule considers perfectly organized
still fails it:

```ts
import { onlyOne } from './src/a';
import './src/side';
import { x, y } from './src/z';
```

```
error eslint(sort-imports): Expected 'None' syntax before 'Single' syntax.
```

Setting `"sort-imports": ["error", { "ignoreDeclarationSort": true }]` resolves it: the
declaration order is then left to this rule, and only the order of names _inside_ each `{ … }`
is checked — which the language service already agrees with, including its case handling.

### Keep these, but expect a second diagnostic

`no-unused-vars` reports the same unused import this rule removes, so until you apply the fix
you see both:

```
error eslint(no-unused-vars): Identifier 'unusedThing' is imported but never used.
error organize-imports(organize-imports): Imports are not organized.
```

Leave it on anyway — it also catches unused locals, parameters and caught errors, which this
rule knows nothing about, and one fix satisfies both.

`no-duplicate-imports` and `import/no-duplicates` are a different matter: in the default `All`
mode, and in `SortAndCombine`, this rule _merges_ duplicate specifiers, so both are fully
redundant and can be switched off. Keep them if you run `RemoveUnused`, which removes unused
imports without merging anything.

## Limitations

- **TypeScript only.** Vue, Svelte, and Angular templates are out of scope: oxlint JS plugins do not support custom parsers yet.
- The plugin drives TypeScript per file, so it is slower than a native oxlint rule. On 5/6 it builds a single-file program per check rather than a full project build, and with `noResolve` the per-file cost is small enough to disappear next to a type-aware lint — [BENCHMARKS.md](./BENCHMARKS.md) has current figures. On 7 the per-file cost is comparable, plus a one-off project load on the first file.

## Development

The source is TypeScript in `src/`, bundled to `dist/` with [tsdown](https://tsdown.dev) (which also runs `publint` on every build). Tests run the real `oxlint` binary against throwaway fixture projects in a temp dir, and they lint the **built** `dist/index.js` — so the suite covers the published artifact, not just the sources.

```sh
pnpm install
pnpm run build       # tsdown -> dist/ (+ publint)
pnpm run test        # vitest; requires a build first
pnpm run lint        # oxlint, type-aware
pnpm run format      # oxfmt
pnpm run ts-check    # tsc --noEmit
pnpm run preflight   # everything, in order
pnpm run benchmark -- <repo>   # see BENCHMARKS.md
```

> [!WARNING]
> Do not verify backend selection with a `link:` install. A linked plugin is a symlink, so Node resolves `typescript` from the plugin's own `node_modules` rather than the consumer's, and the plugin never sees the TypeScript it is supposed to pick a backend for. Use `pnpm pack` and install the tarball instead. See [BENCHMARKS.md](./BENCHMARKS.md).

Both backends are under test on every install: the language service through the repo's own `typescript`, the language server through the aliased `typescript-7` dev dependency, whose platform binary the specs resolve directly. CI additionally pins `typescript@7` in some cells so the CLI suite runs the published bundle against the real selection path.

This repo lints itself with its own plugin: `oxlint-plugin-organize-imports` is a `link:.` devDependency and `organize-imports/organize-imports` is enabled in `.oxlintrc.json`. That is also why oxfmt's `sortImports` is switched **off** here — running both would mean two tools disagreeing about order, exactly as warned above. `pnpm run lint` therefore needs `pnpm run build` to have run first.

## Releasing

Releases are cut by hand and published by CI — there is no changelog tooling; release notes
live in [GitHub Releases](https://github.com/Shinigami92/oxlint-plugin-organize-imports/releases).

1. Bump `version` in `package.json` and merge that to `main`.
2. Wait for CI to be green on `main`.
3. Run the **Publish** workflow (`workflow_dispatch`). It refuses to run off `main`,
   derives the dist-tag from the version (`1.2.3-beta.4` publishes under `beta`), and
   publishes with [provenance](https://docs.npmjs.com/generating-provenance-statements).
4. Draft the GitHub Release for the tag.

`prepublishOnly` runs `clean` + `install` + `build`, so the tarball is always built from a
pristine tree rather than whatever happened to be in `dist/`.

## License

[MIT](./LICENSE)
