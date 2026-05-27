/**
 * @module L5.Gateway
 * Gateway module (L5)
 *
 * 外部客户端 ↔ 内部系统 的实时交互门面。
 * 依赖：Transport (L1) + Stream (L2)
 */

export type {
  Gateway,
  GatewayInput,
  ClientMessage,
  ServerMessage,
} from './types.js';

export { createGateway } from './gateway.js';
export { createAskUserTool } from './ask-user-tool.js';
