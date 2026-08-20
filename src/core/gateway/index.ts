/**
 * @module L5.Gateway
 * Gateway module (L5)
 *
 * 外部客户端 ↔ 内部系统 的实时交互门面。
 * 依赖：Transport (L1) + Stream (L2)
 */

export type {
  Gateway,
} from './types.js';

export { createGateway } from './gateway.js';
// phase 1243: 业主自管 'user_chat' inbox 消息 rendering declaration
export { GATEWAY_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
export { GATEWAY_FILE_ROUTING } from './audit-events.js';
