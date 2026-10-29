/** Versioned, secret-safe wire contract for launcher's first-run setup adapter. */
import { LAUNCHER_CAPABILITIES, type LauncherCapabilities } from './launcher-command.js';

export const LAUNCHER_SETUP_PROTOCOL = 'chestnut.launcher.setup.v1' as const;
export const LAUNCHER_UI_SEMANTICS_PROTOCOL = 'chestnut.ui.v1' as const;

export interface UiScreenSemantics {
  id: string;
  title: string;
  step?: string;
  subtitle?: string;
  status?: string;
  hint?: string;
}

export interface UiFieldSemantics {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  secure?: boolean;
  required?: boolean;
}

export interface UiActionSemantics {
  id: string;
  label: string;
  hint?: string;
  enabledWhen?: string[];
  disabledReason?: string;
}

export interface UiStateSemantics {
  id: string;
  label: string;
  hint?: string;
  busy?: boolean;
  tone?: 'neutral' | 'error';
}

export interface UiErrorSemantics {
  id: string;
  label: string;
  hint?: string;
}

/** Platform-neutral user semantics. Values, drafts, credential refs and platform roles never enter this payload. */
export interface LauncherUiSemantics {
  protocol: typeof LAUNCHER_UI_SEMANTICS_PROTOCOL;
  locale: string;
  screens: Record<string, UiScreenSemantics>;
  fields: Record<string, UiFieldSemantics>;
  actions: Record<string, UiActionSemantics>;
  states: Record<string, UiStateSemantics>;
  errors: Record<string, UiErrorSemantics>;
}

export interface LauncherUiSemanticsContext {
  providerCount?: number;
  providerDescription?: string;
  defaultModel?: string;
}

export function createLauncherUiSemantics(context: LauncherUiSemanticsContext = {}): LauncherUiSemantics {
  const credentialsSubtitle = context.providerDescription
    ? `${context.providerDescription}。填写配置后，验证通过才会保存。`
    : '填写配置后，验证通过才会保存。';
  const modelHint = context.defaultModel
    ? `默认模型：${context.defaultModel}，可直接使用`
    : '模型名称由 CLI 预填，可直接使用。';
  return {
    protocol: LAUNCHER_UI_SEMANTICS_PROTOCOL,
    locale: 'zh-CN',
    screens: {
      'setup.provider': {
        id: 'setup.provider', title: '选择服务供应商', step: '第 1 步，共 3 步',
        subtitle: '选择用于 Motion 的模型服务。',
        ...(context.providerCount !== undefined && { status: `共 ${context.providerCount} 个服务供应商` }),
        hint: '下方还有供应商，可滚动查看',
      },
      'setup.credentials': {
        id: 'setup.credentials', title: '配置模型与凭据', step: '第 2 步，共 3 步', subtitle: credentialsSubtitle,
      },
      'setup.probing': {
        id: 'setup.probing', title: '正在连接并验证配置', subtitle: '正在连接服务并验证当前配置，请稍候。',
      },
      'setup.repair': { id: 'setup.repair', title: '需要调整配置' },
      'setup.starting': { id: 'setup.starting', title: '正在启动 Motion' },
      'setup.start_failure': { id: 'setup.start_failure', title: 'Motion 尚未启动' },
      'setup.language': {
        id: 'setup.language', title: 'Select language / 选择语言', step: '第 3 步，共 3 步',
        subtitle: 'type any word for auto-detect (e.g. hello, 你好)',
      },
      chat: { id: 'chat', title: 'Motion 对话' },
    },
    fields: {
      'credentials.apiKey': {
        id: 'credentials.apiKey', label: 'API Key', placeholder: 'API Key', secure: true, required: true,
      },
      'credentials.model': {
        id: 'credentials.model', label: '模型名称', placeholder: context.defaultModel ?? '模型名称', hint: modelHint, required: true,
      },
      'credentials.baseUrl': {
        id: 'credentials.baseUrl', label: 'Base URL（自定义服务地址）', placeholder: 'Base URL（自定义服务地址）',
      },
      'setup.language': {
        id: 'setup.language', label: '语言样本', placeholder: '留空自动检测；或输入 hello、你好等',
      },
      'chat.composer': { id: 'chat.composer', label: '询问 Motion…', placeholder: '询问 Motion…' },
    },
    actions: {
      'provider.submit': { id: 'provider.submit', label: '继续', enabledWhen: ['provider.selected'] },
      'credentials.submit': { id: 'credentials.submit', label: '验证并保存配置', enabledWhen: ['model.present'] },
      'credentials.back': { id: 'credentials.back', label: '返回上一步' },
      'credentials.cancel': { id: 'credentials.cancel', label: '退出设置' },
      'repair.retry': { id: 'repair.retry', label: '重试' },
      'repair.edit': { id: 'repair.edit', label: '修改配置' },
      'repair.cancel': { id: 'repair.cancel', label: '退出设置' },
      'start.retry': { id: 'start.retry', label: '重试启动' },
      'status.recheck': { id: 'status.recheck', label: '重新检查' },
      'language.submit': { id: 'language.submit', label: '启动 Motion' },
      'chat.send': { id: 'chat.send', label: '发送', enabledWhen: ['composer.nonempty'] },
      'chat.retry': { id: 'chat.retry', label: '重试' },
      'chat.close': { id: 'chat.close', label: '关闭' },
      'chat.interrupt': { id: 'chat.interrupt', label: '中断', enabledWhen: ['turn.active'] },
    },
    states: {
      'setup.waiting': { id: 'setup.waiting', label: '请稍候…', busy: true },
      'setup.ready': { id: 'setup.ready', label: '配置已保存，即将进入对话。' },
      'chat.system': { id: 'chat.system', label: '系统' },
      'activity.idle': { id: 'activity.idle', label: '' },
      'activity.waiting': { id: 'activity.waiting', label: 'Thinking…', busy: true },
      'activity.responding': { id: 'activity.responding', label: 'Streaming…', busy: true },
      'activity.thinking': { id: 'activity.thinking', label: 'Thinking…', busy: true },
      'activity.tool': { id: 'activity.tool', label: 'Tool…', busy: true },
      'activity.error': { id: 'activity.error', label: 'error', tone: 'error' },
      'activity.interrupted': { id: 'activity.interrupted', label: 'interrupted', tone: 'error' },
      'activity.retry': { id: 'activity.retry', label: 'retrying', tone: 'error' },
      'activity.blocked': { id: 'activity.blocked', label: 'blocked', tone: 'error' },
    },
    errors: {
      'setup.auth': { id: 'setup.auth', label: '无法验证配置。请检查 API Key，或修改配置后重试。' },
      'setup.network': { id: 'setup.network', label: '无法验证配置：当前无法连接服务。请检查网络或 Base URL 后重试。' },
      'setup.start': { id: 'setup.start', label: '配置已保存，但 Motion 启动失败。请重试启动。' },
      'setup.transport': { id: 'setup.transport', label: '暂时无法连接 Chestnut，请重新检查。' },
      'setup.unknown': { id: 'setup.unknown', label: '无法验证配置。请检查模型、Base URL 或服务设置后重试。' },
    },
  };
}

export function renderTerminalAction(action: UiActionSemantics): string {
  return action.label;
}

export function isUiActionEnabled(action: UiActionSemantics, facts: Readonly<Record<string, boolean>>): boolean {
  return (action.enabledWhen ?? []).every(requirement => facts[requirement] === true);
}

/** Shared business text for terminal/native activity projections; ANSI, width and roles stay with consumers. */
export function renderTerminalActivity(
  semantics: LauncherUiSemantics,
  activity: { phase: 'idle' | 'waiting' | 'responding' | 'processing' | 'error' | 'interrupted' | 'retry' | 'blocked'; label?: string; detail?: string },
): string | null {
  const detail = activity.detail || undefined;
  if (activity.phase === 'idle') return null;
  if (activity.phase === 'waiting') return semantics.states['activity.waiting'].label;
  if (activity.phase === 'responding') return semantics.states['activity.responding'].label;
  if (activity.phase === 'processing') {
    if (activity.label === 'thinking') return detail ? `(${detail})` : semantics.states['activity.thinking'].label;
    if (activity.label === 'text') return detail ? `"${detail}"` : semantics.states['activity.thinking'].label;
    if (activity.label === 'tool' || activity.label === 'tool_result') return detail ?? semantics.states['activity.tool'].label;
    return semantics.states['activity.thinking'].label;
  }
  return detail ?? semantics.states[`activity.${activity.phase}`].label;
}

export type LauncherSetupAction = 'status' | 'select_provider' | 'submit' | 'retry' | 'cancel';

export interface LauncherSetupRequest {
  protocolVersion: typeof LAUNCHER_SETUP_PROTOCOL;
  requestId: string;
  action: LauncherSetupAction;
  payload?: Record<string, unknown>;
}

export interface LauncherSetupResponse {
  protocolVersion: typeof LAUNCHER_SETUP_PROTOCOL;
  requestId: string;
  kind: 'state' | 'probe' | 'committed' | 'error';
  payload: Record<string, unknown>;
  capabilities?: LauncherCapabilities;
}

const ACTIONS: readonly LauncherSetupAction[] = ['status', 'select_provider', 'submit', 'retry', 'cancel'];

export function parseLauncherSetupRequest(line: string): LauncherSetupRequest {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('setup request must be an object');
  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== LAUNCHER_SETUP_PROTOCOL) throw new Error('unsupported setup protocolVersion');
  if (typeof request.requestId !== 'string' || !request.requestId) throw new Error('requestId is required');
  if (typeof request.action !== 'string' || !ACTIONS.includes(request.action as LauncherSetupAction)) {
    throw new Error('unknown setup action');
  }
  if (request.payload !== undefined && (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))) {
    throw new Error('payload must be an object');
  }
  return request as unknown as LauncherSetupRequest;
}

function semanticsContext(payload: Record<string, unknown>): LauncherUiSemanticsContext {
  const provider = payload.provider && typeof payload.provider === 'object' && !Array.isArray(payload.provider)
    ? payload.provider as Record<string, unknown>
    : undefined;
  const catalog = Array.isArray(payload.catalog) ? payload.catalog : undefined;
  const defaultModel = payload.modelDefault ?? provider?.defaultModel;
  return {
    ...(catalog !== undefined && { providerCount: catalog.length }),
    ...(typeof provider?.description === 'string' && { providerDescription: provider.description }),
    ...(typeof defaultModel === 'string' && { defaultModel }),
  };
}

export function launcherSetupResponse(
  requestId: string,
  kind: LauncherSetupResponse['kind'],
  payload: Record<string, unknown>,
): LauncherSetupResponse {
  const semanticPayload = { ...payload, ui: createLauncherUiSemantics(semanticsContext(payload)) };
  return { protocolVersion: LAUNCHER_SETUP_PROTOCOL, requestId, kind, payload: semanticPayload, capabilities: LAUNCHER_CAPABILITIES };
}
