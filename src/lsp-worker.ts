/**
 * The worker half of the synchronous language-server bridge; `sync-lsp-client.ts` is the
 * other half. It owns the `tsgo` child process and speaks LSP's `Content-Length`-framed
 * JSON-RPC to it over stdio, with an ordinary, asynchronous event loop. The main thread posts
 * requests here and blocks on `Atomics.wait` until the reply is back.
 *
 * This file runs as a `Worker` entry, from `src/` under Node's type stripping during tests
 * and from `dist/` once built, so it imports nothing but Node built-ins.
 */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import type { MessagePort } from 'node:worker_threads';
import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';

/**
 * Opt-in trace of the bridge, for when a lint run stalls somewhere nobody can reproduce.
 * Written straight to fd 2 rather than through `console.error`: a worker's console is
 * forwarded through the main thread's event loop, which is exactly the thread that is
 * blocked waiting for us.
 */
const TRACE = process.env.OXLINT_PLUGIN_ORGANIZE_IMPORTS_TRACE !== undefined;

export function trace(side: 'client' | 'worker', message: string): void {
  if (TRACE) {
    writeSync(2, `[organize-imports:${side} pid=${process.pid} thread=${threadId}] ${message}\n`);
  }
}

/** Set on `workerData` so a stray `import` of this file cannot start a server by accident. */
export const WORKER_KIND = 'oxlint-plugin-organize-imports/lsp-worker';

export interface LspWorkerData {
  readonly kind: typeof WORKER_KIND;
  readonly port: MessagePort;
  /** One `Int32`: the main thread waits on it, the worker sets it when a reply is queued. */
  readonly signal: Int32Array<SharedArrayBuffer>;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
}

/** Main thread → worker. */
export type WorkerCommand =
  | {
      readonly kind: 'request';
      readonly id: number;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: 'notify'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'dispose' };

/** Worker → main thread, one per request. */
export interface WorkerReply {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

interface JsonRpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message: string };
}

const HEADER_END = '\r\n\r\n';
const CONTENT_LENGTH = /Content-Length:\s*(\d+)/iu;

/** One JSON-RPC message in LSP's base-protocol framing. */
export function frame(message: object): string {
  const body = JSON.stringify(message);

  return `Content-Length: ${Buffer.byteLength(body)}${HEADER_END}${body}`;
}

/**
 * Incremental parser for the framing `frame` produces. Feed it chunks as they arrive and it
 * hands back every complete message, holding on to the remainder.
 */
export function createFrameParser(): { push: (chunk: Buffer) => JsonRpcMessage[] } {
  let buffered: Buffer = Buffer.alloc(0);

  return {
    push(chunk): JsonRpcMessage[] {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const messages: JsonRpcMessage[] = [];

      for (;;) {
        const headerEnd = buffered.indexOf(HEADER_END);
        if (headerEnd === -1) {
          break;
        }

        const header = buffered.subarray(0, headerEnd).toString('ascii');
        const match = CONTENT_LENGTH.exec(header);
        if (match === null) {
          throw new Error(`LSP frame without a Content-Length header: ${JSON.stringify(header)}`);
        }

        const bodyStart = headerEnd + HEADER_END.length;
        const bodyEnd = bodyStart + Number(match[1]);
        if (buffered.length < bodyEnd) {
          break;
        }

        messages.push(
          JSON.parse(buffered.subarray(bodyStart, bodyEnd).toString()) as JsonRpcMessage
        );
        buffered = buffered.subarray(bodyEnd);
      }

      return messages;
    },
  };
}

function isLspWorkerData(data: unknown): data is LspWorkerData {
  return (
    typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === WORKER_KIND
  );
}

function run({ port, signal, executable, args, cwd }: LspWorkerData): void {
  const child = spawn(executable, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  trace('worker', `spawned ${executable} (pid ${child.pid ?? 'none'}) in ${cwd ?? process.cwd()}`);
  const parser = createFrameParser();
  const pending = new Set<number>();
  let fatal: string | undefined;

  function reply(message: WorkerReply): void {
    port.postMessage(message);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }

  function fail(reason: string): void {
    trace('worker', reason);
    fatal = reason;
    for (const id of pending) {
      reply({ id, error: { message: reason } });
    }
    pending.clear();
  }

  function send(message: JsonRpcMessage): void {
    child.stdin.write(frame({ jsonrpc: '2.0', ...message }));
  }

  child.stdout.on('data', (chunk: Buffer) => {
    for (const message of parser.push(chunk)) {
      trace('worker', `← ${message.method ?? `#${String(message.id)}`}`);
      if (message.method !== undefined) {
        // A server-initiated request (`client/registerCapability`) gets an empty answer; a
        // notification (`window/logMessage`) is dropped. Neither matters to a lint run.
        if (message.id !== undefined) {
          send({ id: message.id, result: null });
        }
      } else if (typeof message.id === 'number' && pending.delete(message.id)) {
        reply({ id: message.id, result: message.result, error: message.error });
      }
    }
  });
  child.on('error', (error) => {
    fail(`could not start ${executable}: ${error.message}`);
  });
  child.on('exit', (code, signalName) => {
    fail(`${executable} exited unexpectedly (${code ?? signalName ?? 'unknown'})`);
  });
  // A write after the server died surfaces here; `exit` already reported it.
  child.stdin.on('error', () => {});

  parentPort?.on('message', (command: WorkerCommand) => {
    if (command.kind === 'dispose') {
      child.kill();
      port.close();
      parentPort?.close();
      return;
    }

    if (fatal !== undefined) {
      if (command.kind === 'request') {
        reply({ id: command.id, error: { message: fatal } });
      }
      return;
    }

    trace('worker', `→ ${command.kind === 'request' ? `#${command.id} ` : ''}${command.method}`);
    if (command.kind === 'request') {
      pending.add(command.id);
      send({ id: command.id, method: command.method, params: command.params });
    } else {
      send({ method: command.method, params: command.params });
    }
  });
}

if (!isMainThread && isLspWorkerData(workerData)) {
  run(workerData);
}
