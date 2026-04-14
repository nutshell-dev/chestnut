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
