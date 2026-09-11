import fs from 'node:fs';
import path from 'node:path';

/**
 * The nearest `tsconfig.json` at or above `dir`, or `null`.
 *
 * What `ts.findConfigFile` does, minus the dependency: TypeScript 7 does not export it.
 */
export function findTsconfig(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    const candidate = path.join(current, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
