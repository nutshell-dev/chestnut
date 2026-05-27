/**
 * Transport module (L1) — types
 *
 * Real-time bidirectional communication primitives.
 * Protocol (socket/pipe/WebSocket) is internal implementation detail.
 */

/**
 * Represents a connected client.
 */
export interface Connection {
  /** Unique connection identifier */
  id: string;
  /** Unix timestamp (ms) when connection was established */
  connectedAt: number;
}

/**
 * Options for starting a transport listener.
 */
export interface TransportOptions {
  /**
   * Path for local IPC (Unix socket / named pipe).
   * Caller should place this within a claw-owned directory
   * (e.g., `~/.clawforum/<clawId>/transport.sock`); Transport serves
   * same-claw local processes only.
   */
  socketPath?: string;
}

/**
 * Structured failure entry for a single connection during broadcast.
 */
export interface BroadcastFailure {
  connectionId: string;
  error: Error;
}

/**
 * Discriminated union for transport-level error events.
 */
export type TransportErrorEvent =
  | { kind: 'callback_error'; callbackName: 'onConnect' | 'onDisconnect' | 'onMessage' | 'onTransportError'; connectionId?: string; error: Error }
  | { kind: 'server_error'; error: Error }
  | { kind: 'write_failed'; connectionId: string; error: Error; bytes: number }
  | { kind: 'backpressure_pending'; connectionId: string; bufferedBytes: number }
  | { kind: 'drain_completed'; connectionId: string }
  | { kind: 'partial_message_lost'; connectionId: string; bufferedBytes: number; bufferPreview: string }
  | { kind: 'send_error'; connectionId: string; error: Error }
  | { kind: 'buffer_overflow'; connectionId: string; bufferedBytes: number };

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
  send(connectionId: string, data: string): boolean;

  /**
   * Send a message to all connected clients.
   * Returns a list of connections that could not be written to.
   */
  broadcast(data: string): { failed: BroadcastFailure[] };

  /**
   * List currently active connections.
   */
  getConnections(): Connection[];

  /**
   * Register callback for new client connections.
   */
  onConnect(cb: (conn: Connection) => void): () => void;

  /**
   * Register callback for client disconnections.
   * `reason` is present when the socket emitted an error before closing.
   */
  onDisconnect(cb: (conn: Connection, reason?: Error) => void): () => void;

  /**
   * Register callback for incoming client messages.
   *
   * Each callback invocation receives exactly one logical message as framed
   * by the transport. Partial chunks are buffered internally; empty messages
   * (e.g., consecutive delimiters) are still delivered — caller decides
   * whether to ignore them.
   */
  onMessage(cb: (conn: Connection, data: string) => void): () => void;

  /**
   * Register callback for transport-level errors (server errors or
   * exceptions thrown inside other callbacks). Errors are isolated so
   * that one bad callback does not crash the transport.
   */
  onTransportError(cb: (evt: TransportErrorEvent) => void): () => void;
}
