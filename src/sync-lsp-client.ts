import type { MessagePort } from 'node:worker_threads';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { LspWorkerData, WorkerCommand, WorkerReply } from './lsp-worker';
import { WORKER_KIND } from './lsp-worker';

/**
 * Generous on purpose: the first request against a large project makes `tsgo` load the whole
 * program, and a spurious timeout there would be worse than a slow one. A hang past this
 * point is a bug report, not a big repository.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** How long to keep polling the port once the worker has signalled that a reply is queued. */
const RECEIVE_GRACE_MS = 1_000;

export interface SyncLspClientOptions {
  readonly executable: string;
  /**
   * @default ['--lsp', '-stdio']
   */
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  /**
   * @default 300000
   */
  readonly timeoutMs?: number;
}

/**
 * The worker file next to this one. Tests run `src/`, where it is TypeScript that Node strips
 * the types from; the build ships it as a sibling `dist/lsp-worker.js`.
 */
function workerUrl(): URL {
  return new URL(
    import.meta.url.endsWith('.ts') ? './lsp-worker.ts' : './lsp-worker.js',
    import.meta.url
  );
}

/**
 * A JSON-RPC client whose `request` blocks the calling thread until the server answers.
 *
 * oxlint's rule callbacks are synchronous and Node's pipes are not, so the language server is
 * driven from a worker thread with an ordinary event loop, and this thread parks itself on a
 * `SharedArrayBuffer` with `Atomics.wait` until the worker signals a reply. The same trick
 * `synckit` and `esbuild`'s sync API use; unlike reading the child's pipe descriptors
 * directly it needs no private Node API and behaves the same on Windows.
 *
 * Strictly serial: one request in flight at a time, which is all a per-file lint needs.
 */
export class SyncLspClient {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly signal: Int32Array<SharedArrayBuffer>;
  private readonly timeoutMs: number;
  private nextId = 0;
  private disposed = false;

  constructor({
    executable,
    args = ['--lsp', '-stdio'],
    cwd,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: SyncLspClientOptions) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    this.timeoutMs = timeoutMs;

    const workerData: LspWorkerData = {
      kind: WORKER_KIND,
      port: port2,
      signal: this.signal,
      executable,
      args,
      cwd,
    };
    this.worker = new Worker(workerUrl(), { workerData, transferList: [port2] });

    // Neither may keep the process alive once linting is done. The server itself exits when
    // its stdin closes, which happens the moment this process does.
    this.worker.unref();
    this.port.unref();
  }

  /** The server's `result`; callers know the shape the method promises. */
  request(method: string, params: unknown): unknown {
    this.assertOpen();
    const id = ++this.nextId;

    Atomics.store(this.signal, 0, 0);
    this.post({ kind: 'request', id, method, params });

    if (Atomics.wait(this.signal, 0, 0, this.timeoutMs) === 'timed-out') {
      throw new Error(`tsgo did not answer '${method}' within ${this.timeoutMs} ms`);
    }

    const reply = this.receive(id, method);
    if (reply.error !== undefined) {
      throw new Error(`tsgo rejected '${method}': ${reply.error.message}`);
    }

    return reply.result;
  }

  notify(method: string, params: unknown): void {
    this.assertOpen();
    this.post({ kind: 'notify', method, params });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.post({ kind: 'dispose' });
    this.port.close();
    void this.worker.terminate();
  }

  private post(command: WorkerCommand): void {
    // A `worker_threads` port, not a browser window: there is no origin to target.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    this.worker.postMessage(command);
  }

  /**
   * The worker enqueues its reply before it touches the signal, so the message is normally
   * there the instant `Atomics.wait` returns. The short poll covers the delivery being
   * observed a beat late, and skips any reply left behind by a request that timed out.
   */
  private receive(id: number, method: string): WorkerReply {
    const deadline = performance.now() + RECEIVE_GRACE_MS;
    for (;;) {
      const received = receiveMessageOnPort(this.port);
      if (received !== undefined) {
        const reply = received.message as WorkerReply;
        if (reply.id === id) {
          return reply;
        }
      } else if (performance.now() > deadline) {
        throw new Error(`tsgo signalled a reply to '${method}' that never arrived`);
      }
    }
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error('The language server connection has been disposed.');
    }
  }
}
