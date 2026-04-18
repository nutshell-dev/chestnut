import { createServer, connect, type Server, type Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Transport, TransportOptions } from './index.js';
import type { Connection } from './types.js';

interface ConnectionEntry {
  sock: Socket;
  meta: Connection;
  buf: string;
}

export class UnixDomainSocketTransport implements Transport {
  private server: Server | null = null;
  private socketPath: string | null = null;
  private connections = new Map<string, ConnectionEntry>();
  private connectCbs: ((c: Connection) => void)[] = [];
  private disconnectCbs: ((c: Connection) => void)[] = [];
  private messageCbs: ((c: Connection, data: string) => void)[] = [];
  private closed = false;

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
          console.error('[transport] server error:', err);
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
          fs.unlink(this.socketPath!)
            .catch((err) => {
              console.error(`[transport] failed to unlink stale socket ${this.socketPath}:`, err);
            })
            .then(() => resolve());
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
    sock.on('data', (chunk: string) => {
      entry.buf += chunk;
      let nl = entry.buf.indexOf('\n');
      while (nl >= 0) {
        const line = entry.buf.slice(0, nl);
        entry.buf = entry.buf.slice(nl + 1);
        this.safeFire(this.messageCbs, 'onMessage', meta, line);
        nl = entry.buf.indexOf('\n');
      }
    });
    sock.on('error', (err) => {
      console.error(`[transport] connection ${id} error:`, err);
    });
    sock.on('close', () => {
      this.connections.delete(id);
      this.safeFire(this.disconnectCbs, 'onDisconnect', meta);
    });
    this.safeFire(this.connectCbs, 'onConnect', meta);
  }

  send(connectionId: string, data: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`unknown connection: ${connectionId}`);
    entry.sock.write(data + '\n');
  }

  broadcast(data: string): void {
    const line = data + '\n';
    for (const { sock } of this.connections.values()) {
      try {
        sock.write(line);
      } catch (err) {
        console.error('[transport] broadcast write error:', err);
      }
    }
  }

  getConnections(): Connection[] {
    return Array.from(this.connections.values(), (e) => e.meta);
  }

  onConnect(cb: (conn: Connection) => void): void {
    this.connectCbs.push(cb);
  }

  onDisconnect(cb: (conn: Connection) => void): void {
    this.disconnectCbs.push(cb);
  }

  onMessage(cb: (conn: Connection, data: string) => void): void {
    this.messageCbs.push(cb);
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
        console.error(`[transport] ${label} callback error:`, err);
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
        await fs.unlink(this.socketPath);
      } catch {
        // already gone
      }
    }
  }
}
