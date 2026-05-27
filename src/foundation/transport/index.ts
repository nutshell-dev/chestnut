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

export type { Connection, Transport, TransportOptions, BroadcastFailure, TransportErrorEvent } from './types.js';

// Latent advertise — 0 production caller, retained as future transport hook
// per phase 1055 ⚓ accepted-stable β. Detail: l1_transport.md §7.A A.r125-unix-socket-dead-code
export { UnixDomainSocketTransport } from './unix-socket.js';
