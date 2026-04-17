/**
 * Transport module (L1)
 *
 * Real-time bidirectional communication primitives.
 * Manages connections to external clients (TUI, IM bot).
 * Protocol (socket/pipe/WebSocket) is internal implementation detail.
 *
 * Resources: none
 * Dependencies: none
 * Coupling: none
 * Consumer: Gateway
 */

import type { Connection } from './types.js';
export type { Connection } from './types.js';

/**
 * Options for starting a transport listener.
 */
export interface TransportOptions {
  /** Path for local IPC (Unix socket / named pipe). */
  socketPath?: string;
}

/**
 * Transport interface — real-time bidirectional communication.
 *
 * Lifecycle:
 *   listen() → [client connects → communicates → disconnects]* → close()
 *
 * Messages are opaque strings. Transport does not interpret event semantics
 * (that is Gateway's responsibility).
 */
export interface Transport {
  /**
   * Start listening for client connections.
   * Resolves when the listener is ready.
   */
  listen(options?: TransportOptions): Promise<void>;

  /**
   * Stop listening and close all active connections.
   * Resolves when fully shut down.
   */
  close(): Promise<void>;

  /**
   * Send a message to a specific connected client.
   * Throws if connectionId is not found (caller error, should be caught).
   */
  send(connectionId: string, data: string): void;

  /**
   * Send a message to all connected clients.
   * Best-effort delivery: silently skips disconnected clients.
   */
  broadcast(data: string): void;

  /**
   * List currently active connections.
   */
  getConnections(): Connection[];

  /**
   * Register callback for new client connections.
   */
  onConnect(cb: (conn: Connection) => void): void;

  /**
   * Register callback for client disconnections.
   */
  onDisconnect(cb: (conn: Connection) => void): void;

  /**
   * Register callback for incoming client messages.
   */
  onMessage(cb: (conn: Connection, data: string) => void): void;
}

// TODO: UnixDomainSocketTransport implementation — future phase
