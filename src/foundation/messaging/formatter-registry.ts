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
  /** 声明该 type 业务语义的稳定模块标识，用于装配冲突诊断。 */
  readonly owner: string;
  readonly type: string;
  readonly rendering: InboxMessageRendering;
}

export interface InboxMessageRenderingResolver {
  /**
   * 按 message type 查 rendering。未注册返 undefined（caller 负责
   * fallback + DP 不静默 audit）。
   */
  resolve(type: string): InboxMessageRendering | undefined;
}

export interface InboxMessageTypeRegistry extends InboxMessageRenderingResolver {
  /**
   * 注册某 message type 的 rendering declaration。同一 owner 的完全相同声明可重复
   * 注册；跨 owner 或 rendering 不同的重复声明 fail loud，禁止装配顺序改变语义。
   */
  register(declaration: InboxMessageTypeDeclaration): void;
}


export function createInboxMessageTypeRegistry(): InboxMessageTypeRegistry {
  const map = new Map<string, InboxMessageTypeDeclaration>();
  return {
    register(declaration) {
      const existing = map.get(declaration.type);
      if (existing === undefined) {
        map.set(declaration.type, declaration);
        return;
      }
      if (
        existing.owner === declaration.owner
        && inboxMessageRenderingEqual(existing.rendering, declaration.rendering)
      ) {
        return;
      }
      throw new Error(
        `Inbox message type declaration conflict: type=${JSON.stringify(declaration.type)}`
        + ` existingOwner=${JSON.stringify(existing.owner)}`
        + ` incomingOwner=${JSON.stringify(declaration.owner)}`,
      );
    },
    resolve(type) {
      return map.get(type)?.rendering;
    },
  };
}

function inboxMessageRenderingEqual(a: InboxMessageRendering, b: InboxMessageRendering): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'standard' && b.kind === 'standard') return a.presentation === b.presentation;
  return a.kind === 'custom' && b.kind === 'custom' && a.formatter === b.formatter;
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
