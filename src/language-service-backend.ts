import path from 'node:path';
import ts from 'typescript';
import type { Backend, GetService, ServiceEntry, Settings, TextChange } from './types';

/**
 * Whether the installed `typescript` is one that ships the JavaScript language service.
 *
 * Importing `typescript@7` succeeds and even reports a `version`, so the only reliable probe
 * is to look for the API this backend actually needs.
 */
export function hasLanguageService(): boolean {
  return (
    typeof ts.createLanguageService === 'function' &&
    typeof ts.getDefaultFormatCodeSettings === 'function' &&
    ts.OrganizeImportsMode !== undefined
  );
}

/**
 * `organizeImports` decides what is unused from the *local* reference graph: it needs the
 * parser, the binder, and the file's own checker, but never the types behind a module
 * specifier. `noResolve` stops TypeScript from loading and parsing every transitively
 * imported file, which is the overwhelming majority of the work in a single-file program.
 *
 * This is a large speedup for no change in output. Measurements, and the environment they
 * were taken in, live in BENCHMARKS.md, which `pnpm run benchmark` regenerates:
 * https://github.com/Shinigami92/oxlint-plugin-organize-imports/blob/main/BENCHMARKS.md
 */
export const PERFORMANCE_OPTIONS: ts.CompilerOptions = { noResolve: true };

/**
 * The path form TypeScript itself produces: separators forward, `.` and `..` resolved.
 *
 * The language service normalises every path before handing it to the host, so a host that
 * keeps the caller's raw string compares against something TypeScript never emits. On Windows
 * that is *every* path, because `path.resolve` yields backslashes there — `getScriptSnapshot`
 * then misses, the file never enters the program, and `organizeImports` throws
 * `Could not find source file`. Case is preserved by the language service, so this
 * deliberately does not fold it.
 */
function normalizeFileName(filename: string): string {
  return path.resolve(filename).replaceAll('\\', '/');
}

/**
 * One `LanguageService` per tsconfig, reused for every file in the run.
 *
 * The host only ever reports the *current* file as a root, so TypeScript builds a
 * single-file program: `organizeImports` needs the binder and the local checker, not a
 * project-wide type graph. This is the same trick `prettier-plugin-organize-imports` and
 * `organize-imports-cli` use, and it is what keeps the plugin fast enough to run per-file
 * inside a linter.
 *
 * @param compilerOptionOverrides Merged over the tsconfig's options. Defaults to
 *   {@link PERFORMANCE_OPTIONS}; the benchmark passes `{}` to measure their effect.
 */
export function createServiceCache(
  compilerOptionOverrides: ts.CompilerOptions = PERFORMANCE_OPTIONS
): GetService {
  const services = new Map<string, ServiceEntry>();
  const compilerOptions = new Map<string, ts.CompilerOptions>();

  function getCompilerOptions(tsconfigPath: string | null | undefined): ts.CompilerOptions {
    if (tsconfigPath === undefined || tsconfigPath === null || tsconfigPath.length === 0) {
      return { allowJs: true, allowNonTsExtensions: true, ...compilerOptionOverrides };
    }

    const cached = compilerOptions.get(tsconfigPath);
    if (cached) {
      return cached;
    }

    // `readConfigFile` types `config` as `any`; keep it opaque and hand it straight on.
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const config: unknown = configFile.config;
    const { options } = ts.parseJsonConfigFileContent(
      config ?? {},
      ts.sys,
      path.dirname(tsconfigPath)
    );

    const withOverrides = { ...options, ...compilerOptionOverrides };
    compilerOptions.set(tsconfigPath, withOverrides);

    return withOverrides;
  }

  return function getService(tsconfigPath) {
    const key = tsconfigPath ?? '';
    const cached = services.get(key);
    if (cached) {
      return cached;
    }

    const state = { file: '', text: '', version: 0, cwd: '' };
    const options = getCompilerOptions(tsconfigPath);

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [state.file],
      getScriptVersion: () => String(state.version),
      getScriptSnapshot: (fileName) => {
        if (fileName === state.file) {
          return ts.ScriptSnapshot.fromString(state.text);
        }

        const text = ts.sys.readFile(fileName);

        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCompilationSettings: () => options,
      getDefaultLibFileName: ts.getDefaultLibFileName,
      getCurrentDirectory: () => state.cwd,
      getNewLine: () => ts.sys.newLine,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      getDirectories: ts.sys.getDirectories,
      directoryExists: ts.sys.directoryExists,
    };

    const entry: ServiceEntry = { service: ts.createLanguageService(host), state };
    services.set(key, entry);

    return entry;
  };
}

/** The language service's view of the plugin's settings. */
export function toFormatCodeSettings(settings: Settings): ts.FormatCodeSettings {
  return {
    ...ts.getDefaultFormatCodeSettings(settings.newLine),
    convertTabsToSpaces: !settings.useTabs,
    tabSize: settings.tabWidth,
    indentSize: settings.tabWidth,
  };
}

export interface LanguageServiceBackend extends Backend {
  readonly kind: 'language-service';
  readonly getService: GetService;
}

/**
 * The TypeScript 5/6 backend: `ts.createLanguageService` in this process.
 *
 * @param compilerOptionOverrides See {@link createServiceCache}.
 */
export function createLanguageServiceBackend(
  compilerOptionOverrides?: ts.CompilerOptions
): LanguageServiceBackend {
  const getService = createServiceCache(compilerOptionOverrides);

  return {
    kind: 'language-service',
    getService,
    prepare(): void {
      // Services are created per tsconfig on demand; there is nothing to start ahead of time.
    },
    organize(filename, text, tsconfigPath, settings): ReadonlyArray<TextChange> {
      // Once, here: everything downstream — `state.file`, `getScriptFileNames`, and the name
      // the service is asked about — has to be the same string the host will be called back
      // with.
      const file = normalizeFileName(filename);

      const { service, state } = getService(tsconfigPath);
      state.file = file;
      state.text = text;
      state.cwd = path.dirname(file);
      state.version++;

      const [changes] = service.organizeImports(
        { type: 'file', fileName: file, mode: ts.OrganizeImportsMode[settings.mode] },
        toFormatCodeSettings(settings),
        // `organizeImports` reprints existing import declarations verbatim, so it never
        // rewrites module-specifier quotes and `quotePreference` has no effect here. Left
        // empty on purpose.
        {}
      );

      return changes?.textChanges ?? [];
    },
    dispose(): void {
      // Language services are garbage-collected with the cache; nothing to release.
    },
  };
}
