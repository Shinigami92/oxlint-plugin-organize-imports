/**
 * A stand-in language server for `sync-lsp-client.spec.ts`: LSP framing over stdio, with
 * just enough behaviour to prove the bridge — echoing, ordering, a request of its own, a
 * delayed answer, and a crash. Node runs it directly; it imports nothing that needs a build.
 */
interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const notes: unknown[] = [];
const awaitingClient = new Map<number, (result: unknown) => void>();
let nextServerId = 1000;
let buffered: Buffer = Buffer.alloc(0);

function send(message: Message): void {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(message: Message): void {
  if (message.method === undefined) {
    // The client answering a request of ours.
    if (message.id !== undefined) {
      awaitingClient.get(message.id)?.(message.result);
      awaitingClient.delete(message.id);
    }
    return;
  }

  const { id, method, params } = message;
  if (id === undefined) {
    notes.push({ method, params });
    return;
  }

  switch (method) {
    case 'echo':
      send({ id, result: params });
      break;
    case 'notes':
      send({ id, result: notes });
      break;
    case 'slow':
      setTimeout(
        () => {
          send({ id, result: 'late' });
        },
        (params as { ms: number }).ms
      );
      break;
    case 'askClient': {
      const serverId = nextServerId++;
      awaitingClient.set(serverId, (result) => {
        send({ id, result: { clientAnswered: result } });
      });
      send({ id: serverId, method: 'client/registerCapability', params: {} });
      send({ method: 'window/logMessage', params: { type: 4, message: 'noise' } });
      break;
    }
    case 'crash':
      process.exit(3);
      break;
    default:
      send({ id, result: null });
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }
    const header = buffered.subarray(0, headerEnd).toString();
    const length = Number(header.match(/Content-Length: (\d+)/u)?.[1]);
    const bodyStart = headerEnd + 4;
    if (buffered.length < bodyStart + length) {
      return;
    }
    handle(JSON.parse(buffered.subarray(bodyStart, bodyStart + length).toString()) as Message);
    buffered = buffered.subarray(bodyStart + length);
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
