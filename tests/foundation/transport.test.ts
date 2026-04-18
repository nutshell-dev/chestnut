import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { UnixDomainSocketTransport } from '../../src/foundation/transport/index.js';
import type { Connection } from '../../src/foundation/transport/index.js';

const TIMEOUT_MS = 2000;

function makeSocketPath(): string {
  return join(tmpdir(), `clawforum-test-${randomUUID()}.sock`);
}

function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(path);
    const timer = setTimeout(() => reject(new Error('client connect timeout')), TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setEncoding('utf8');
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitFor<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function nextLine(sock: Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        sock.off('data', onData);
        resolve(buf.slice(0, nl));
      }
    };
    sock.on('data', onData);
  });
}

describe('UnixDomainSocketTransport', () => {
  let transport: UnixDomainSocketTransport | null = null;
  let clients: Socket[] = [];

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients = [];
    if (transport) await transport.close();
    transport = null;
  });

  it('listen and close idempotently', async () => {
    transport = new UnixDomainSocketTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    await transport.close();
    await transport.close(); // second close is no-op
    expect(true).toBe(true);
  });

  it('accepts a client connection and fires onConnect', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const connSeen = new Promise<Connection>((resolve) => {
      transport!.onConnect((c) => resolve(c));
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    const conn = await waitFor(connSeen, 'onConnect');
    expect(conn.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(transport.getConnections()).toHaveLength(1);
  });

  it('server.send reaches the client', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const connSeen = new Promise<Connection>((resolve) => {
      transport!.onConnect((c) => resolve(c));
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    const conn = await waitFor(connSeen, 'onConnect');
    const recv = nextLine(c);
    transport.send(conn.id, '{"hello":"world"}');
    const line = await waitFor(recv, 'client recv');
    expect(line).toBe('{"hello":"world"}');
  });

  it('server.broadcast reaches all clients', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    let connects = 0;
    const twoConnected = new Promise<void>((resolve) => {
      transport!.onConnect(() => {
        connects++;
        if (connects === 2) resolve();
      });
    });
    await transport.listen({ socketPath: path });
    const c1 = await connectClient(path);
    const c2 = await connectClient(path);
    clients.push(c1, c2);
    await waitFor(twoConnected, 'two connects');
    const r1 = nextLine(c1);
    const r2 = nextLine(c2);
    transport.broadcast('ping');
    const [l1, l2] = await waitFor(Promise.all([r1, r2]), 'broadcast recv');
    expect(l1).toBe('ping');
    expect(l2).toBe('ping');
  });

  it('client disconnect fires onDisconnect', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const gone = new Promise<Connection>((resolve) => {
      transport!.onDisconnect((c) => resolve(c));
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    // wait one tick for server-side connection registration
    await new Promise((r) => setTimeout(r, 20));
    c.end();
    const conn = await waitFor(gone, 'onDisconnect');
    expect(conn.id).toMatch(/^[0-9a-f-]{36}$/);
    // allow close event to propagate
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.getConnections()).toHaveLength(0);
  });

  it('client message fires onMessage', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const got = new Promise<{ conn: Connection; data: string }>((resolve) => {
      transport!.onMessage((conn, data) => resolve({ conn, data }));
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    c.write('{"type":"interrupt"}\n');
    const { data } = await waitFor(got, 'onMessage');
    expect(data).toBe('{"type":"interrupt"}');
  });

  it('throws on send to unknown connectionId', async () => {
    transport = new UnixDomainSocketTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    expect(() => transport!.send('not-a-real-id', 'x')).toThrow(/unknown connection/);
  });

  it('handles many concurrent connections independently', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const conns: Connection[] = [];
    transport.onConnect((c) => conns.push(c));
    await transport.listen({ socketPath: path });

    const cs = await Promise.all([0, 1, 2, 3, 4].map(() => connectClient(path)));
    clients.push(...cs);
    await waitFor(
      new Promise<void>((resolve) => {
        const tick = () => (conns.length === 5 ? resolve() : setTimeout(tick, 10));
        tick();
      }),
      '5 connects',
    );

    const recvs = cs.map((c) => nextLine(c));
    transport.broadcast('hi');
    const lines = await waitFor(Promise.all(recvs), 'all receive');
    expect(lines).toEqual(['hi', 'hi', 'hi', 'hi', 'hi']);

    cs[2].destroy();
    await new Promise((r) => setTimeout(r, 30));
    const recvs2 = [cs[0], cs[1], cs[3], cs[4]].map((c) => nextLine(c));
    transport.broadcast('again');
    const lines2 = await waitFor(Promise.all(recvs2), 'remaining receive');
    expect(lines2).toEqual(['again', 'again', 'again', 'again']);
    expect(transport.getConnections()).toHaveLength(4);
  });

  it('cleans up stale socket file from dead process', async () => {
    const path = makeSocketPath();
    await fs.writeFile(path, '');
    transport = new UnixDomainSocketTransport();
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    expect(transport.getConnections().length >= 0).toBe(true);
  });

  it('refuses to steal a socket held by a live listener', async () => {
    const path = makeSocketPath();
    const t1 = new UnixDomainSocketTransport();
    await t1.listen({ socketPath: path });
    const t2 = new UnixDomainSocketTransport();
    await expect(t2.listen({ socketPath: path })).rejects.toThrow(/in use by a live process/);
    await t1.close();
  });

  it('splits and merges TCP chunks into whole-line messages', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const msgs: string[] = [];
    transport.onMessage((_c, d) => msgs.push(d));
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    await new Promise((r) => setTimeout(r, 20));
    c.write('a\nb\nc\n');
    c.write('hel');
    c.write('lo\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(msgs).toEqual(['a', 'b', 'c', 'hello']);
  });

  it('rejects new connections after close', async () => {
    const path = makeSocketPath();
    const t = new UnixDomainSocketTransport();
    await t.listen({ socketPath: path });
    await t.close();
    await expect(connectClient(path)).rejects.toThrow();
  });

  it('close during pending listen rejects listen', async () => {
    const path = makeSocketPath();
    const t = new UnixDomainSocketTransport();
    const p = t.listen({ socketPath: path });
    await t.close();
    await expect(p).rejects.toThrow(/closed during listen/);
  });

  it('throws on double listen', async () => {
    transport = new UnixDomainSocketTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    await expect(transport.listen({ socketPath: makeSocketPath() })).rejects.toThrow(
      /already listening/,
    );
  });

  it('isolates exceptions thrown in onMessage callbacks', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const got: string[] = [];
    transport.onMessage(() => {
      throw new Error('cb1 boom');
    });
    transport.onMessage((_c, d) => got.push(d));
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    c.write('a\nb\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(['a', 'b']);
  });

  it('delivers empty messages from consecutive delimiters', async () => {
    const path = makeSocketPath();
    transport = new UnixDomainSocketTransport();
    const msgs: string[] = [];
    transport.onMessage((_c, d) => msgs.push(d));
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    c.write('a\n\nb\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(msgs).toEqual(['a', '', 'b']);
  });
});
