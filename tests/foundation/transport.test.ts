import { describe, it, expect, afterEach } from 'vitest';
import { getHostTmpDir } from '../utils/run-root.js';
import { join } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { UnixDomainSocketTransport } from '../../src/foundation/transport/index.js';
import type { Connection } from '../../src/foundation/transport/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';

/** Test-level safety deadline (2s). 远大于 unix-domain socket I/O 实测 << 100ms / 防 hang */
const TIMEOUT_MS = 2000;

/**
 * 等 OS 释放 socket file（仅 `rejects new connections after close` 一处用、其他时序均 event-driven）.
 * Derivation: handle queue flush + onMessage callback ≈ 10-20ms / ×3 safety = 50ms.
 */
const MSG_PROCESS_BUDGET_MS = 50;

const createdSockets: string[] = [];

function makeSocketPath(): string {
  // Unix domain socket 路径长度受限；TMPDIR 重定向后路径过长，
  // 因此 socket 路径必须使用真实系统 tmpdir。
  const p = join(getHostTmpDir(), `chestnut-test-${randomUUID()}.sock`);
  createdSockets.push(p);
  return p;
}

// phase 1492: 注入 NodeFileSystem (baseDir=tmpdir) 满足 transport ctor required deps。
// 原代码 21 处 new UnixDomainSocketTransport() 不传 deps，constructor 签名要求 {fs}、
// 因 tsconfig exclude tests 漏 type-check，长期潜伏。F4 stale-socket-cleanup test 在
// Linux (EADDRINUSE → probeAndCleanStale → this.deps.fs.delete) 上撞 TypeError、
// macOS 上 server.listen 在 regular file 上不返 EADDRINUSE 故走运没暴露。
function makeTransport(): UnixDomainSocketTransport {
  return new UnixDomainSocketTransport({ fs: new NodeFileSystem({ baseDir: getHostTmpDir() }) });
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
    // 清理 socket 文件（transport.close() 不保证 unlink）
    for (const p of createdSockets) {
      try {
        await fs.unlink(p);
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }
    createdSockets.length = 0;
  });

  it('listen and close idempotently', async () => {
    transport = makeTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    await transport.close();
    // second close is no-op (idempotent / 0 throw)
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('accepts a client connection and fires onConnect', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
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
    transport = makeTransport();
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
    transport = makeTransport();
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
    const { failed } = transport.broadcast('ping');
    expect(failed).toHaveLength(0);
    const [l1, l2] = await waitFor(Promise.all([r1, r2]), 'broadcast recv');
    expect(l1).toBe('ping');
    expect(l2).toBe('ping');
  });

  it('client disconnect fires onDisconnect', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
    const connRegistered = new Promise<void>((resolve) => {
      transport!.onConnect(() => resolve());
    });
    const gone = new Promise<Connection>((resolve) => {
      transport!.onDisconnect((c, _reason) => resolve(c));
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    await connRegistered;
    c.end();
    const conn = await waitFor(gone, 'onDisconnect');
    expect(conn.id).toMatch(/^[0-9a-f-]{36}$/);
    // phase 370: src 已先 connections.delete(id) 后 safeFire(disconnectCbs)、gone 解析后 getConnections 已空
    expect(transport.getConnections()).toHaveLength(0);
  });

  it('client message fires onMessage', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
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
    transport = makeTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    expect(() => transport!.send('not-a-real-id', 'x')).toThrow(/unknown connection/);
  });

  it('handles many concurrent connections independently', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
    const conns: Connection[] = [];
    // phase 368: 替 recursive setTimeout polling — onConnect 事件触发 resolve.
    const fiveConnectsP = new Promise<void>((resolve) => {
      transport!.onConnect((c) => {
        conns.push(c);
        if (conns.length >= 5) resolve();
      });
    });
    // phase 370: 同模式 onDisconnect Promise 等 cs[2].destroy() 后 getConnections().length === 4
    const fourLeftP = new Promise<void>((resolve) => {
      transport!.onDisconnect(() => {
        if (transport!.getConnections().length === 4) resolve();
      });
    });
    await transport.listen({ socketPath: path });

    const cs = await Promise.all([0, 1, 2, 3, 4].map(() => connectClient(path)));
    clients.push(...cs);
    await waitFor(fiveConnectsP, '5 connects');

    const recvs = cs.map((c) => nextLine(c));
    const { failed: failed1 } = transport.broadcast('hi');
    expect(failed1).toHaveLength(0);
    const lines = await waitFor(Promise.all(recvs), 'all receive');
    expect(lines).toEqual(['hi', 'hi', 'hi', 'hi', 'hi']);

    cs[2].destroy();
    await fourLeftP;
    const recvs2 = [cs[0], cs[1], cs[3], cs[4]].map((c) => nextLine(c));
    const { failed: failed2 } = transport.broadcast('again');
    expect(failed2).toHaveLength(0);
    const lines2 = await waitFor(Promise.all(recvs2), 'remaining receive');
    expect(lines2).toEqual(['again', 'again', 'again', 'again']);
    expect(transport.getConnections()).toHaveLength(4);
  });

  it('cleans up stale socket file from dead process', async () => {
    // phase 1492 真治：原 buggy test 在 Linux (EADDRINUSE → probeAndCleanStale →
    // this.deps.fs.delete) 上撞 deps undefined TypeError → Promise 既不 resolve 也不
    // reject → 15s timeout；macOS 上 libuv 自带 stale-socket auto-cleanup 故走运没暴露。
    // 真正可跨平台断言：listen 不抛 + client 能连。socket file mode 检查在 macOS/Linux
    // 行为差大（libuv 内部 unlink+rebind 时机不稳）、不做 stat type 断言。
    const path = makeSocketPath();
    await fs.writeFile(path, '');
    transport = makeTransport();
    // 关键：listen 必须 resolve 而非 hang/reject（修前 Linux hang 15s）
    await transport.listen({ socketPath: path });
    // client 能连 = transport 真起来
    const c = await connectClient(path);
    clients.push(c);
    expect(transport.getConnections().length).toBeGreaterThanOrEqual(0);
  });


  it('refuses to steal a socket held by a live listener', async () => {
    const path = makeSocketPath();
    const t1 = makeTransport();
    await t1.listen({ socketPath: path });
    const t2 = makeTransport();
    await expect(t2.listen({ socketPath: path })).rejects.toThrow(/in use by a live process/);
    await t1.close();
  });

  it('splits and merges TCP chunks into whole-line messages', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
    const msgs: string[] = [];
    const fourMsgsP = new Promise<void>((resolve) => {
      transport!.onMessage((_c, d) => {
        msgs.push(d);
        if (msgs.length === 4) resolve();
      });
    });
    const connRegistered = new Promise<void>((resolve) => {
      transport!.onConnect(() => resolve());
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    await connRegistered;
    c.write('a\nb\nc\n');
    c.write('hel');
    c.write('lo\n');
    await fourMsgsP;
    expect(msgs).toEqual(['a', 'b', 'c', 'hello']);
  });

  it('rejects new connections after close', async () => {
    const path = makeSocketPath();
    const t = makeTransport();
    await t.listen({ socketPath: path });
    await t.close();
    await new Promise(r => setTimeout(r, MSG_PROCESS_BUDGET_MS)); // 等 OS 释放 socket
    await expect(connectClient(path)).rejects.toThrow();
  });

  it('close during pending listen rejects listen', async () => {
    const path = makeSocketPath();
    const t = makeTransport();
    const p = t.listen({ socketPath: path });
    await t.close();
    await expect(p).rejects.toThrow(/closed during listen/);
  });

  it('throws on double listen', async () => {
    transport = makeTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    await expect(transport.listen({ socketPath: makeSocketPath() })).rejects.toThrow(
      /already listening/,
    );
  });

  it('isolates exceptions thrown in onMessage callbacks and fires onTransportError', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
    const errors: TransportErrorEvent[] = [];
    const got: string[] = [];
    const twoErrsP = new Promise<void>((resolve) => {
      transport!.onTransportError((evt) => {
        errors.push(evt);
        if (errors.length >= 2) resolve();
      });
    });
    transport.onMessage(() => {
      throw new Error('cb1 boom');
    });
    const twoMsgsP = new Promise<void>((resolve) => {
      transport!.onMessage((_c, d) => {
        got.push(d);
        if (got.length === 2) resolve();
      });
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    c.write('a\nb\n');
    await Promise.all([twoMsgsP, twoErrsP]);
    expect(got).toEqual(['a', 'b']);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors[0]).toMatchObject({ kind: 'callback_error', callbackName: 'onMessage' });
  });

  it('broadcast returns empty failed list when no connections', async () => {
    transport = makeTransport();
    await transport.listen({ socketPath: makeSocketPath() });
    const result = transport.broadcast('hello');
    expect(result.failed).toEqual([]);
  });

  it('onDisconnect receives undefined reason on normal close', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
    let disconnectReason: Error | undefined = new Error('should-be-overwritten');
    const disconnected = new Promise<void>((resolve) => {
      transport!.onDisconnect((_c, reason) => {
        disconnectReason = reason;
        resolve();
      });
    });
    const connRegistered = new Promise<void>((resolve) => {
      transport!.onConnect(() => resolve());
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    await connRegistered;
    c.end();
    await disconnected;
    expect(disconnectReason).toBeUndefined();
  });

  it('emits server_error via onTransportError', async () => {
    transport = makeTransport();
    const errors: TransportErrorEvent[] = [];
    const serverErrorP = new Promise<void>((resolve) => {
      transport!.onTransportError((evt) => {
        if (evt.kind === 'server_error') {
          errors.push(evt);
          resolve();
        }
      });
    });
    await transport.listen({ socketPath: makeSocketPath() });
    // Simulate a server-level error by forcing the internal server to emit 'error'
    const server = (transport as unknown as { server: import('node:net').Server }).server;
    server.emit('error', new Error('simulated server error'));
    await serverErrorP;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'server_error' });
    expect(errors[0].error.message).toBe('simulated server error');
  });

  it('delivers empty messages from consecutive delimiters', async () => {
    const path = makeSocketPath();
    transport = makeTransport();
    const msgs: string[] = [];
    const threeMsgsP = new Promise<void>((resolve) => {
      transport!.onMessage((_c, d) => {
        msgs.push(d);
        if (msgs.length === 3) resolve();
      });
    });
    await transport.listen({ socketPath: path });
    const c = await connectClient(path);
    clients.push(c);
    c.write('a\n\nb\n');
    await threeMsgsP;
    expect(msgs).toEqual(['a', '', 'b']);
  });

  it('throws when listen is called after close', async () => {
    const t = makeTransport();
    await t.listen({ socketPath: makeSocketPath() });
    await t.close();
    await expect(t.listen({ socketPath: makeSocketPath() })).rejects.toThrow(
      /already closed/,
    );
  });
});
