import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findTsconfig } from '../src/tsconfig';

describe('findTsconfig', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oxlint-organize-tsconfig-'));
  const tsconfig = path.join(root, 'tsconfig.json');
  fs.writeFileSync(tsconfig, '{}');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the file in the directory itself', () => {
    expect(findTsconfig(root)).toBe(tsconfig);
  });

  it('walks up through nested directories', () => {
    expect(findTsconfig(path.join(root, 'src', 'deep'))).toBe(tsconfig);
  });

  it('prefers the nearest one', () => {
    const nearer = path.join(root, 'src', 'tsconfig.json');
    fs.writeFileSync(nearer, '{}');

    try {
      expect(findTsconfig(path.join(root, 'src', 'deep'))).toBe(nearer);
    } finally {
      fs.rmSync(nearer);
    }
  });

  it('returns null when nothing is found up to the filesystem root', () => {
    // A fresh temp directory with no tsconfig of its own; nothing above the temp root has one.
    const bare = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oxlint-organize-bare-'));

    try {
      expect(findTsconfig(bare)).toBeNull();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
