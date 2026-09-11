import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFrameParser, frame } from '../src/lsp-worker';
import { SyncLspClient } from '../src/sync-lsp-client';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-lsp-server.ts', import.meta.url));

const clients: SyncLspClient[] = [];

/** A client talking to the fixture server, run by the current Node binary. */
function connect(options: { timeoutMs?: number } = {}): SyncLspClient {
  const client = new SyncLspClient({
    executable: process.execPath,
    args: [FAKE_SERVER],
    ...options,
  });
  clients.push(client);

  return client;
}

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.dispose();
  }
});

describe('SyncLspClient', () => {
  it('returns the result of a request synchronously', () => {
    const client = connect();

    expect(client.request('echo', { hello: 'world' })).toEqual({ hello: 'world' });
    expect(client.request('echo', 42)).toBe(42);
  });

  it('delivers notifications and requests in the order they were sent', () => {
    const client = connect();

    client.notify('first', 1);
    client.notify('second', 2);

    expect(client.request('notes', null)).toEqual([
      { method: 'first', params: 1 },
      { method: 'second', params: 2 },
    ]);
  });

  it('answers a request from the server with null and ignores its notifications', () => {
    const client = connect();

    expect(client.request('askClient', null)).toEqual({ clientAnswered: null });
  });

  it('fails the pending request when the server exits, and every request after it', () => {
    const client = connect();

    expect(() => client.request('crash', null)).toThrow(/exited unexpectedly \(3\)/u);
    expect(() => client.request('echo', 1)).toThrow(/exited unexpectedly/u);
  });

  it('fails a request the server takes too long to answer', () => {
    const client = connect({ timeoutMs: 100 });

    expect(() => client.request('slow', { ms: 2_000 })).toThrow(/did not answer 'slow'/u);
  });

  it('fails immediately when the executable cannot be started', () => {
    const client = new SyncLspClient({ executable: '/no/such/language-server' });
    clients.push(client);

    expect(() => client.request('echo', 1)).toThrow(/could not start \/no\/such\/language-server/u);
  });

  it('refuses to be used once disposed', () => {
    const client = connect();
    client.dispose();
    client.dispose();

    expect(() => client.request('echo', 1)).toThrow(/disposed/u);
    expect(() => {
      client.notify('echo', 1);
    }).toThrow(/disposed/u);
  });
});

describe('frame parser', () => {
  it('round-trips a framed message', () => {
    const parser = createFrameParser();

    expect(parser.push(Buffer.from(frame({ id: 1, result: 'ok' })))).toEqual([
      { id: 1, result: 'ok' },
    ]);
  });

  it('reassembles a message split across chunks, and splits chunks holding several', () => {
    const parser = createFrameParser();
    const two = frame({ id: 1 }) + frame({ id: 2 });
    const bytes = Buffer.from(two);

    expect(parser.push(bytes.subarray(0, 10))).toEqual([]);
    expect(parser.push(bytes.subarray(10, 30))).toEqual([{ id: 1 }]);
    expect(parser.push(bytes.subarray(30))).toEqual([{ id: 2 }]);
  });

  it('measures the body in bytes, not characters', () => {
    const parser = createFrameParser();

    expect(parser.push(Buffer.from(frame({ result: 'ünïcödé — 日本' })))).toEqual([
      { result: 'ünïcödé — 日本' },
    ]);
  });

  it('rejects a frame without a Content-Length header', () => {
    const parser = createFrameParser();

    expect(() => parser.push(Buffer.from('Content-Type: text\r\n\r\n{}'))).toThrow(
      /without a Content-Length header/u
    );
  });
});
