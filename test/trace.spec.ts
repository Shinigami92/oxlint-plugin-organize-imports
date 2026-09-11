import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SyncLspClientModule from '../src/sync-lsp-client';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-lsp-server.ts', import.meta.url));

/**
 * The debugging knobs: the trace flag and the timeout override are read when the bridge's
 * modules load, so each case stubs the environment first and imports a fresh copy. What is
 * asserted is behaviour — the override shortening the wait, the traced client still working —
 * since the worker's half of the trace is written from another thread, out of reach of a spy.
 */
function loadClient(): Promise<typeof SyncLspClientModule> {
  vi.resetModules();

  return import('../src/sync-lsp-client');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('OXLINT_PLUGIN_ORGANIZE_IMPORTS_TIMEOUT_MS', () => {
  it('shortens how long a request waits', async () => {
    vi.stubEnv('OXLINT_PLUGIN_ORGANIZE_IMPORTS_TIMEOUT_MS', '200');
    const { SyncLspClient } = await loadClient();
    const client = new SyncLspClient({ executable: process.execPath, args: [FAKE_SERVER] });

    try {
      expect(() => client.request('slow', { ms: 5_000 })).toThrow(/within 200 ms/u);
    } finally {
      client.dispose();
    }
  });

  it.each(['', 'soon', '-5', '0'])('falls back to the default for %j', async (value) => {
    vi.stubEnv('OXLINT_PLUGIN_ORGANIZE_IMPORTS_TIMEOUT_MS', value);
    const { SyncLspClient } = await loadClient();
    const client = new SyncLspClient({ executable: process.execPath, args: [FAKE_SERVER] });

    try {
      // A bogus override must not turn into a zero or negative wait that fails everything.
      expect(client.request('echo', 'still works')).toBe('still works');
    } finally {
      client.dispose();
    }
  });
});

describe('OXLINT_PLUGIN_ORGANIZE_IMPORTS_TRACE', () => {
  it('leaves the bridge working while it narrates', async () => {
    vi.stubEnv('OXLINT_PLUGIN_ORGANIZE_IMPORTS_TRACE', '1');
    const { SyncLspClient } = await loadClient();
    const client = new SyncLspClient({ executable: process.execPath, args: [FAKE_SERVER] });

    try {
      client.notify('note', 1);
      expect(client.request('echo', { traced: true })).toEqual({ traced: true });
      expect(client.request('askClient', null)).toEqual({ clientAnswered: null });
    } finally {
      client.dispose();
    }

    // Let the worker's exit reach the observers this thread registered on it.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  });
});
