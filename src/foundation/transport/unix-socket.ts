/**
 * UnixDomainSocketTransport — Transport implementation over Unix domain sockets.
 *
 * **Latent advertise** (phase 1055 ⚓ accepted-stable, user ratify β 2026-05-19).
 *
 * Currently 0 production caller (assemble.ts:538 wires `transport: undefined`
 * for motion offline mode). Retained as future transport hook per user
 * decision; do NOT delete without re-ratifying.
 *
 * Detail: `design/modules/l1_transport.md §7.A A.r125-unix-socket-dead-code`
 * + phase 1118 in-file marker補 (`coding plan/phase1118/`).
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { FileSystem } from '../fs/types.js';
import { isFileNotFound } from '../fs/types.js';
import { AUDIT_PREVIEW_LEN } from '../constants.js';
import type { Transport, TransportOptions, BroadcastFailure, TransportErrorEvent } from './types.js';
import type { Connection } from './types.js';

interface ConnectionEntry {
  sock: Socket;
  meta: Connection;
  buf: string;
}

/** Latent advertise — see file header. Future wire site: `assemble.ts:538` */
export class UnixDomainSocketTransport implements Transport {
  private server: Server | null = null;
  private socketPath: string | null = null;
  private connections = new Map<string, ConnectionEntry>();
  private connectCbs: ((c: Connection) => void)[] = [];
  private disconnectCbs: ((c: Connection, reason?: Error) => void)[] = [];
  private transportErrorCbs: ((evt: TransportErrorEvent) => void)[] = [];
  private messageCbs: ((c: Connection, data: string) => void)[] = [];
  private closed = false;

  constructor(private deps: { fs: FileSystem }) {}

  async listen(options?: TransportOptions): Promise<void> {
    if (!options?.socketPath) throw new Error('socketPath required');
    if (this.closed) throw new Error('transport already closed');
    if (this.server || this.socketPath) throw new Error('transport already listening');
    this.socketPath = options.socketPath;
    await this.tryListen(true);
  }

  private tryListen(allowCleanup: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.handleConnection(sock));
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && allowCleanup) {
          this.probeAndCleanStale().then(
            () => this.tryListen(false).then(resolve, reject),
            reject,
          );
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(this.socketPath!, () => {
        server.off('error', onError);
        if (this.closed) {
          server.close(() => reject(new Error('transport closed during listen')));
          return;
        }
        server.on('error', (err) => {
          this.fireTransportError({ kind: 'server_error', error: err });
        });
        this.server = server;
        resolve();
      });
    });
  }

  private probeAndCleanStale(): Promise<void> {
    return new Promise((resolve, reject) => {
      const probe = connect(this.socketPath!);
      probe.once('connect', () => {
        probe.destroy();
        reject(new Error(`socket ${this.socketPath} is in use by a live process`));
      });
      probe.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          this.deps.fs.delete(path.basename(this.socketPath!)).then(
            () => resolve(),
            (err: unknown) => {
              // ENOENT 例外 silent：文件已不在 = race 良性
              if (isFileNotFound(err)) {
                resolve();
                return;
              }
              // 其他 IO 错 reject 透传 reason / caller 通过 listen() reject 链路 audit STARTUP_FAILED
              reject(new Error(`unlink stale socket ${this.socketPath} failed: ${err instanceof Error ? err.message : String(err)}`));
            },
          );
        } else {
          reject(err);
        }
      });
    });
  }

  private handleConnection(sock: Socket): void {
    const id = randomUUID();
    const meta: Connection = { id, connectedAt: Date.now() };
    const entry: ConnectionEntry = { sock, meta, buf: '' };
    this.connections.set(id, entry);
    sock.setEncoding('utf8');
    const MAX_BUF_BYTES = 10 * 1024 * 1024; // 10MB
    sock.on('data', (chunk: string) => {
      entry.buf += chunk;
      if (entry.buf.length > MAX_BUF_BYTES) {
        this.fireTransportError({
          kind: 'buffer_overflow',
          connectionId: id,
          bufferedBytes: entry.buf.length,
        });
        sock.destroy();
        return;
      }
      let nl = entry.buf.indexOf('\n');
      while (nl >= 0) {
        const line = entry.buf.slice(0, nl);
        entry.buf = entry.buf.slice(nl + 1);
        this.safeFire(this.messageCbs, 'onMessage', meta, line);
        nl = entry.buf.indexOf('\n');
      }
    });
    let disconnectReason: Error | undefined;
    sock.on('error', (err) => {
      disconnectReason = err;
    });
    sock.on('close', () => {
      if (entry.buf.length > 0) {
        this.fireTransportError({
          kind: 'partial_message_lost',
          connectionId: id,
          bufferedBytes: entry.buf.length,
          bufferPreview: entry.buf.slice(0, AUDIT_PREVIEW_LEN),
        });
      }
      this.connections.delete(id);
      this.safeFire(this.disconnectCbs, 'onDisconnect', meta, disconnectReason);
    });
    this.safeFire(this.connectCbs, 'onConnect', meta);
  }

  send(connectionId: string, data: string): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`unknown connection: ${connectionId}`);
    const line = data + '\n';
    try {
      const ok = entry.sock.write(line);
      if (!ok) {
        this.fireTransportError({
          kind: 'backpressure_pending',
          connectionId,
          bufferedBytes: entry.sock.writableLength,
        });
        this.armDrainOnce(connectionId, entry.sock);
      }
      return ok;
    } catch (err) {
      this.fireTransportError({
        kind: 'send_error',
        connectionId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
  }

  broadcast(data: string): { failed: BroadcastFailure[] } {
    const line = data + '\n';
    const failed: BroadcastFailure[] = [];
    for (const { sock, meta } of this.connections.values()) {
      try {
        const ok = sock.write(line);
        if (!ok) {
          this.fireTransportError({
            kind: 'backpressure_pending',
            connectionId: meta.id,
            bufferedBytes: sock.writableLength,
          });
          this.armDrainOnce(meta.id, sock);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.fireTransportError({
          kind: 'write_failed',
          connectionId: meta.id,
          error,
          bytes: line.length,
        });
        failed.push({
          connectionId: meta.id,
          error,
        });
      }
    }
    return { failed };
  }

  getConnections(): Connection[] {
    return Array.from(this.connections.values(), (e) => e.meta);
  }

  onConnect(cb: (conn: Connection) => void): () => void {
    this.connectCbs.push(cb);
    return () => {
      const idx = this.connectCbs.indexOf(cb);
      if (idx !== -1) this.connectCbs.splice(idx, 1);
    };
  }

  onDisconnect(cb: (conn: Connection, reason?: Error) => void): () => void {
    this.disconnectCbs.push(cb);
    return () => {
      const idx = this.disconnectCbs.indexOf(cb);
      if (idx !== -1) this.disconnectCbs.splice(idx, 1);
    };
  }

  onTransportError(cb: (evt: TransportErrorEvent) => void): () => void {
    this.transportErrorCbs.push(cb);
    return () => {
      const idx = this.transportErrorCbs.indexOf(cb);
      if (idx !== -1) this.transportErrorCbs.splice(idx, 1);
    };
  }

  onMessage(cb: (conn: Connection, data: string) => void): () => void {
    this.messageCbs.push(cb);
    return () => {
      const idx = this.messageCbs.indexOf(cb);
      if (idx !== -1) this.messageCbs.splice(idx, 1);
    };
  }

  private armDrainOnce(connectionId: string, sock: Socket): void {
    if (sock.listenerCount('drain') > 0) return;
    sock.once('drain', () => {
      if (!this.connections.has(connectionId)) return;
      this.fireTransportError({
        kind: 'drain_completed',
        connectionId,
      });
    });
  }

  private fireTransportError(evt: TransportErrorEvent): void {
    for (const cb of this.transportErrorCbs) {
      try {
        cb(evt);
      } catch (err) {
        // silent: callback error already observable via transportErrorCbs fire
      }
    }
  }

  private safeFire<T extends unknown[]>(
    cbs: ((...args: T) => void)[],
    label: string,
    ...args: T
  ): void {
    for (const cb of cbs) {
      try {
        cb(...args);
      } catch (err) {
        this.fireTransportError({
          kind: 'callback_error',
          callbackName: label as 'onConnect' | 'onDisconnect' | 'onMessage',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.server) return;
    for (const { sock } of this.connections.values()) sock.destroy();
    const server = this.server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.socketPath) {
      try {
        await this.deps.fs.delete(path.basename(this.socketPath));
      } catch {
        // silent: socket file may already be cleaned up by OS or prior close
      }
    }
  }
}
