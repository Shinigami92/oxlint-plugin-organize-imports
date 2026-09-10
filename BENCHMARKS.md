# Benchmarks

Numbers here exist to justify one decision: the program is built with **`noResolve`**.

`organizeImports` decides what is unused from a file's _local_ reference graph. It needs the
parser, the binder, and the file's own checker — but never the types behind a module
specifier. `noResolve` stops TypeScript from loading and parsing every transitively imported
file, which in a single-file program is nearly all of the work.

The claim being tested is therefore two-sided, and both sides matter:

1. it is **much faster**, and
2. it produces **identical output** — same files changed, same replacement text.

A speedup that quietly broke unused-import removal would look like an improvement on an
already-clean repository, so every run reports how many files the two variants disagreed on.
That number must be `0`.

### That `0` is only meaningful if something changed

On a repository that is already organized — which is the normal state of any repo with a
formatter in CI — both variants return "no change" for every file, and "0 files differing" is
`0` nulls compared to `0` nulls. It proves nothing.

`--mangle` fixes that. It reverses each file's leading imports (exercising sorting) and
injects an unreferenced binding from an existing specifier (exercising unused-import removal,
the one thing `noResolve` could plausibly break) before sweeping. The runner refuses to
present an equivalence result at all when no file was organized, and says to re-run with the
flag instead.

Every repository below is therefore measured twice: **as committed** for the honest
real-world cost, and **mangled** for the safety claim.

## Method

`pnpm run benchmark -- <path-to-target-repo>` sweeps every file the rule would actually look
at in the target repo — the same extension filter and the same `// organize-imports-ignore`
check the rule uses, via the shared `isOrganizable` predicate — and organizes each one
through the real `organizeFile`, once per mode, once per variant:

| Variant                | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `noResolve (shipped)`  | what the plugin actually does                        |
| `module resolution on` | the same code with the performance overrides removed |

Each variant warms up on 25 files, then runs the full sweep `--runs` times (default 3) and
reports the **median**. Timings cover the language-service work only, not oxlint's own
startup or its other rules — for end-to-end `pnpm run lint` numbers, see the notes under each
result.

### Run them one at a time

Two sweeps competing for CPU produce numbers that mean nothing. The runner takes an
exclusive lock (`$TMPDIR/oxlint-plugin-organize-imports.benchmark.lock`) and refuses to start
while another run holds it, including one started by a different person or agent on the same
machine. If a run crashes and leaves the lock behind, re-run with `--force`.

### Reading the entries

Every entry records the date, the **target repo's commit**, and the **plugin's commit**, since
a result is meaningless without both. `(dirty tree)` means the working tree had uncommitted
changes at measurement time, so the commit alone does not identify the code that ran.

## Results

<!-- Paste the output of `pnpm run benchmark` below, newest first. -->

### faker — 2026-09-10 (as committed)

| Field                         | Value                                                   |
| ----------------------------- | ------------------------------------------------------- |
| Target repo                   | `faker` @ `53bf4dd6`                                    |
| Target commit                 | `53bf4dd648e1c216eb69ef2320ec2186aee42aaa`              |
| Plugin commit                 | `28b28e99ff0763ca34235a905ee8956e1d827a0f` (dirty tree) |
| TypeScript                    | 6.0.3                                                   |
| oxlint                        | 1.82.0                                                  |
| Node.js                       | v26.7.0                                                 |
| Platform                      | darwin/arm64, Apple M1 Max                              |
| TS files swept                | 3596                                                    |
| Runs (median, after 1 warmup) | 3                                                       |

| Mode           | Variant              | Total  | Per file | Files changed |
| -------------- | -------------------- | ------ | -------- | ------------- |
| All            | noResolve (shipped)  | 1.6 s  | 0.45 ms  | 0             |
| All            | module resolution on | 71.3 s | 19.83 ms | 0             |
| SortAndCombine | noResolve (shipped)  | 1.3 s  | 0.35 ms  | 0             |
| SortAndCombine | module resolution on | 68.4 s | 19.02 ms | 0             |

- `All`: **43.9x** faster. Equivalence not tested — no file needed organizing (see the mangled
  run below).
- `SortAndCombine`: **54.4x** faster. Equivalence not tested, same reason.

**End-to-end.** Measured separately by running the real `oxlint` binary over faker with the
plugin registered in its `jsPlugins`: `pnpm run lint` went from **6.7 s** to **9.3 s**
(+2.6 s, 1.39x) with no per-directory overrides, and reported **0** organize-imports
diagnostics. Before `noResolve`, the same measurement was 80.4 s (+74 s, 12.2x). That run
used faker's own pinned toolchain — oxlint 1.80.0, oxfmt 0.65.0 — rather than this repo's.

### faker — 2026-09-10 (mangled)

Same repo and commit, imports reversed and one unused import injected per file. The corpus is
1153 rather than 3596 files because faker is 84% generated locale data with no imports at all,
and a file with no imports has nothing to mangle — so this is effectively faker's real source.

| Field                         | Value                                                      |
| ----------------------------- | ---------------------------------------------------------- |
| Target commit                 | `53bf4dd648e1c216eb69ef2320ec2186aee42aaa`                 |
| Plugin commit                 | `28b28e99ff0763ca34235a905ee8956e1d827a0f` (dirty tree)    |
| TS files swept                | 1153                                                       |
| Corpus                        | imports reversed + one unused import injected (`--mangle`) |
| Runs (median, after 1 warmup) | 1                                                          |

| Mode           | Variant              | Total  | Per file | Files changed |
| -------------- | -------------------- | ------ | -------- | ------------- |
| All            | noResolve (shipped)  | 1.3 s  | 1.09 ms  | 1153          |
| All            | module resolution on | 72.0 s | 62.43 ms | 1153          |
| SortAndCombine | noResolve (shipped)  | 0.9 s  | 0.78 ms  | 1153          |
| SortAndCombine | module resolution on | 69.6 s | 60.33 ms | 1153          |

- `All`: **57.1x** faster, **0** of 1153 organized files with differing output.
- `SortAndCombine`: **77.0x** faster, **0** of 1153 organized files with differing output.

Note the per-file cost with resolution on rises from 20 ms to 62 ms once the locale data is
excluded, which lines up with node-pg-migrate's 123 ms: the cost tracks how much real import
graph a file has, and `noResolve` is flat regardless.

### node-pg-migrate — 2026-09-10 (as committed)

| Field                         | Value                                                   |
| ----------------------------- | ------------------------------------------------------- |
| Target repo                   | `node-pg-migrate` @ `5fd96ba`                           |
| Target commit                 | `5fd96baafd878ea3c7448105f38a0f2de8f894ff`              |
| Plugin commit                 | `28b28e99ff0763ca34235a905ee8956e1d827a0f` (dirty tree) |
| TypeScript                    | 6.0.3                                                   |
| oxlint                        | 1.82.0                                                  |
| Node.js                       | v26.7.0                                                 |
| Platform                      | darwin/arm64, Apple M1 Max                              |
| TS files swept                | 276                                                     |
| Corpus                        | as committed                                            |
| Runs (median, after 1 warmup) | 3                                                       |

| Mode           | Variant              | Total  | Per file  | Files changed |
| -------------- | -------------------- | ------ | --------- | ------------- |
| All            | noResolve (shipped)  | 0.4 s  | 1.44 ms   | 0             |
| All            | module resolution on | 33.9 s | 122.94 ms | 0             |
| SortAndCombine | noResolve (shipped)  | 0.3 s  | 1.01 ms   | 0             |
| SortAndCombine | module resolution on | 33.5 s | 121.53 ms | 0             |

- `All`: **85.1x** faster. Equivalence not tested — no file needed organizing.
- `SortAndCombine`: **120.5x** faster. Equivalence not tested, same reason.

**End-to-end.** `pnpm run lint` went from **2.10 s** to **3.02 s** (+0.92 s, ~+44%), with **0**
organize-imports diagnostics repo-wide.

**Per-file cost is ~6x faker's** with resolution on (123 ms vs 20 ms), because this is real
source with a deep relative-import graph and `pg` types, where faker is 84% generated locale
data with few imports. `noResolve` stays flat at ~1–1.5 ms/file, so the speedup _rises_ with
how real the type graph is.

### node-pg-migrate — 2026-09-10 (mangled)

Same repo and commit, imports reversed and one unused import injected per file. 236 of 269
files were actually organized, so this is the entry the safety claim rests on.

| Mode           | Variant              | Total  | Per file  | Files changed |
| -------------- | -------------------- | ------ | --------- | ------------- |
| All            | noResolve (shipped)  | 0.4 s  | 1.52 ms   | 236           |
| All            | module resolution on | 33.3 s | 123.68 ms | 236           |
| SortAndCombine | noResolve (shipped)  | 0.3 s  | 1.17 ms   | 219           |
| SortAndCombine | module resolution on | 33.4 s | 124.19 ms | 219           |

- `All`: **81.4x** faster, **0** of 236 organized files with differing output.
- `SortAndCombine`: **106.0x** faster, **0** of 219 organized files with differing output.

The 236 vs 219 gap is exactly the 17 single-import files: nothing to sort, but the injected
unused import still removed. That is direct evidence unused-import detection survives
`noResolve`.

## Caveat: `link:` installs cannot test the TypeScript 7 guard

The plugin refuses to load against `typescript@7`, which dropped the JS language service.
That guard reads the **consumer's** TypeScript — but under `pnpm add -D link:<path>` the
plugin directory is a symlink, so Node resolves `typescript` from the _plugin's_ own
`node_modules`, never the consumer's. A `link:`-installed plugin in a TS 7 repo therefore
runs happily on the plugin's own TS 6, and the guard never fires.

That is a property of the rehearsal, not a bug: verified on 2026-09-10 by `pnpm pack`ing the
plugin and installing the tarball (a real copy) into a fixture with `typescript@7.0.2`, where
the guard fires as intended. Test the TS 7 path with a packed install, never with `link:`.
