/**
 * @module L1.Transport
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

export type { Connection, Transport } from './types.js';


