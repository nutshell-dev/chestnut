import { describe, it, expect, afterEach, vi } from 'vitest';
import { getHostTmpDir } from '../../utils/run-root.js';
import { join } from 'node:path';
import { connect as netConnect, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { UnixDomainSocketTransport } from '../../../src/foundation/transport/unix-socket.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';

/** Test-level safety deadline (2s). 远大于 unix-domain socket I/O 实测 << 100ms / 防 hang */
const TIMEOUT_MS = 2000;

/**
 * phase 1422 Step A: fireTransportError handler throw 可观察性锁。
 *
 * 修复前：handler throw 被 catch 静默吞（无输出）。
 * 修复后：[AUDIT CRITICAL] console.error 兜底（audit/writer.ts 同型），
 * 且 catch 在循环内——单 handler throw 不阻断剩余 handlers。
 */

const createdSockets: string[] = [];

function makeSocketPath(): string {
  const p = join(getHostTmpDir(), `ct-${randomUUID().slice(0, 16)}.sock`);
  createdSockets.push(p);
  return p;
}

function makeTransport(socketPath = makeSocketPath()): UnixDomainSocketTransport {
  return new UnixDomainSocketTransport({
    fs: new NodeFileSystem({ baseDir: getHostTmpDir() }),
    socketPath,
  });
}

function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(path);
    const timer = setTimeout(() => reject(new Error('client connect timeout')), TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
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
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

describe('fireTransportError handler throw observability (phase 1422)', () => {
  let transport: UnixDomainSocketTransport | null = null;
  let client: Socket | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    consoleErrorSpy?.mockRestore();
    client?.destroy();
    client = null;
    if (transport) await transport.close();
    transport = null;
    for (const p of createdSockets) {
      try {
        await fs.unlink(p);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    }
    createdSockets.length = 0;
  });

  it('callback_error: throwing handler triggers [AUDIT CRITICAL] console.error and does not block remaining handlers', async () => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = makeSocketPath();
    transport = makeTransport(path);

    const secondHandlerCalled = new Promise<void>((resolve) => {
      transport!.onTransportError(() => {
        throw new Error('handler1 boom');
      });
      transport!.onTransportError(() => resolve());
    });
    transport.onMessage(() => {
      throw new Error('onMessage boom');
    });

    await transport.listen();
    client = await connectClient(path);
    client.write('x\n');
    await waitFor(secondHandlerCalled, 'second onTransportError handler');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const out = consoleErrorSpy.mock.calls[0][0] as string;
    expect(out).toContain('[AUDIT CRITICAL]');
    expect(out).toContain('kind=callback_error');
    expect(out).toContain('callbackName=onMessage');
    expect(out).toContain('handler1 boom');
  });

  it('server_error: throwing handler triggers [AUDIT CRITICAL] console.error with kind context and does not block remaining handlers', async () => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    transport = makeTransport();

    const secondHandlerCalled = new Promise<void>((resolve) => {
      transport!.onTransportError(() => {
        throw new Error('handler1 boom');
      });
      transport!.onTransportError(() => resolve());
    });

    await transport.listen();
    // 触发 server 'error' → fireTransportError({ kind: 'server_error' })
    const server = (transport as unknown as { server?: Server }).server;
    expect(server).toBeDefined();
    server!.emit('error', new Error('server boom'));

    await waitFor(secondHandlerCalled, 'second onTransportError handler');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const out = consoleErrorSpy.mock.calls[0][0] as string;
    expect(out).toContain('[AUDIT CRITICAL]');
    expect(out).toContain('kind=server_error');
    expect(out).toContain('handler1 boom');
  });
});
