/**
 * @module L2c.Messaging
 * phase 1243: inbox 消息 rendering 声明协议
 *
 * 业务语义 = inbox 消息格式化时机/接口、归 Messaging L2 own。
 * 业务 owner 只声明 type 对应的 presentation（standard）或自管 algorithm（custom）。
 * Messaging 提供 standard renderer；Runtime 仅 dispatch + DP 不静默 fallback。
 */

/** 已 format 好的"(2m ago)"字串、formatter 不重复 format。空串表示无 timestamp。*/
export interface MessageFormatterContext {
  /** 消息发件方 claw id 或 'system' */
  from: string;
  /** 消息正文 */
  body: string;
  /** caller 已 format 好的" (2m ago)"字串（含前导空格）；空串=无 timestamp */
  timestampSec: string;
}

export type MessageFormatter = (ctx: MessageFormatterContext) => Promise<string>;

export type StandardMessagePresentation = 'system' | 'user_chat' | 'user_inbox';

export type InboxMessageRendering =
  | { readonly kind: 'standard'; readonly presentation: StandardMessagePresentation }
  | { readonly kind: 'custom'; readonly formatter: MessageFormatter };

export interface InboxMessageTypeDeclaration {
  readonly type: string;
  readonly rendering: InboxMessageRendering;
}

export interface InboxMessageTypeRegistry {
  /**
   * 注册某 message type 的 rendering declaration。重复注册按 last-win（业主多次注册
   * 仍 idempotent / 防多个装配路径误重）。装配期一次性调用、运行期不再改。
   */
  register(declaration: InboxMessageTypeDeclaration): void;

  /**
   * 按 message type 查 rendering。未注册返 undefined（caller 负责
   * fallback + DP 不静默 audit）。
   */
  resolve(type: string): InboxMessageRendering | undefined;
}


export function createInboxMessageTypeRegistry(): InboxMessageTypeRegistry {
  const map = new Map<string, InboxMessageRendering>();
  return {
    register(declaration) {
      map.set(declaration.type, declaration.rendering);
    },
    resolve(type) {
      return map.get(type);
    },
  };
}


/**
 * 标准 presentation renderer。同步纯函数、 exhaustive switch。
 * - system: `[system message<ts>] <body>`
 * - user_inbox: `[user inbox message<ts>]\n<body>`
 * - user_chat: `<body>`
 */
export function renderStandardInboxMessage(
  ctx: MessageFormatterContext,
  presentation: StandardMessagePresentation,
): string {
  switch (presentation) {
    case 'system':
      return `[system message${ctx.timestampSec}] ${ctx.body}`;
    case 'user_inbox':
      return `[user inbox message${ctx.timestampSec}]\n${ctx.body}`;
    case 'user_chat':
      return ctx.body;
    default:
      return assertNever(presentation);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected standard presentation: ${String(value)}`);
}

/**
 * 批量注册 declarations。仅 helper；registry 仍按 declaration 原子注册。
 */
export function registerInboxMessageTypes(
  registry: InboxMessageTypeRegistry,
  declarations: readonly InboxMessageTypeDeclaration[],
): void {
  for (const declaration of declarations) {
    registry.register(declaration);
  }
}
