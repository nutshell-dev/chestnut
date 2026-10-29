/**
 * @module L6.CLIProtocol
 *
 * Phase 1253 Step B 立：CLIProtocol public barrel（M#7/M#8）。
 *
 * 调用方（CLIProcess router / Assembly guidance）只见本 barrel 的
 * catalog / query / render API，不见内部 layout helper 或文件 layout。
 */

export type {
  ClawCommandSpec,
  CommandArg,
  CommandOption,
  CommandForm,
  CommandGroup,
} from './command-spec.js';
export {
  CLAW_COMMAND_CATALOG,
  CLAW_INSTANCE_COMMAND_IDS,
  DEFAULT_OUTBOX_READ_LIMIT,
  getClawCommandSpec,
  applyClawCommandOptions,
  type ClawOptionRegistrar,
  type ClawCommandId,
  type ClawInstanceCommandId,
} from './claw-command-catalog.js';
export {
  formatClawStatusHint,
} from './claw-status-hint.js';
export {
  renderClawHelp,
  renderClawCommandHelp,
} from './help.js';
export {
  viewportConfigSchema,
  VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT,
} from './viewport-config.js';
export {
  renderCliGuidanceAction,
  renderCliGuidanceDocument,
  CliGuidanceRenderError,
  type CliGuidanceTarget,
  type CliGuidanceAction,
  type CliGuidanceLabel,
  type CliGuidanceSubject,
  type CliGuidanceDocumentLine,
  type CliGuidanceTruncation,
  type CliGuidanceDocument,
  type CliGuidanceInput,
  type CliGuidanceRegistrar,
  type CliGuidanceBinding,
  defineCliGuidanceBinding,
  registerCliGuidance,
  createCliSafeToken,
  type CliSafeToken,
} from './guidance.js';

// phase 1874 Step L: 命令形状 catalog 投影（motion 族首发；1798 claw 形态泛化）
export { applyCommandOptions } from './command-shape.js';
export type { CommandShapeSpec, CommandOptionShape, CommandShapeRegistrar } from './command-shape.js';

// phase 1990 Step B：chestnut.launcher.v1 对外协议 envelope（静态 wire protocol 单源）
// phase 1994 Step B：运行时 producer（LauncherEventMapper/makeLauncherSessionId）
// 拆至 src/cli/launcher-envelope-producer.ts，不进协议 barrel。
export {
  LAUNCHER_PROTOCOL_VERSION,
  createLauncherSequencer,
  launcherActivityEnvelope,
  launcherErrorEnvelope,
  makeLauncherEnvelope,
  writeLauncherEnvelope,
  LAUNCHER_PROTOCOL_VERSION_V2,
  makeLauncherV2Envelope,
  writeLauncherV2Envelope,
  parseLauncherV2Envelope,
} from './launcher-envelope.js';
export type {
  LauncherEnvelope,
  LauncherEnvelopeKind,
  LauncherErrorClass,
  LauncherActivityPayload,
  LauncherActivityPhase,
  LauncherActivityLabel,
  LauncherV2Envelope,
  LauncherV2EnvelopeKind,
  UnknownLauncherV2Envelope,
  LauncherSnapshotPayload,
  LauncherDaemonPayload,
  LauncherMessagePayload,
  LauncherSendAckPayload,
  LauncherErrorPayload,
  DaemonState,
  LauncherOnboardingState,
  DeliveryState,
  LauncherTerminalReason,
} from './launcher-envelope.js';
export {
  LAUNCHER_SETUP_PROTOCOL,
  LAUNCHER_UI_SEMANTICS_PROTOCOL,
  createLauncherUiSemantics,
  isUiActionEnabled,
  renderTerminalAction,
  renderTerminalActivity,
  parseLauncherSetupRequest,
  launcherSetupResponse,
} from './launcher-setup.js';
export {
  LAUNCHER_COMMANDS,
  LAUNCHER_CAPABILITIES,
  parseLauncherStatusRequest,
  parseLauncherStartRequest,
  parseLauncherSendRequest,
  parseLauncherStreamRequest,
} from './launcher-command.js';
export type {
  LauncherCommand,
  LauncherCapabilities,
  LauncherCommandRequest,
  LauncherStatusRequest,
  LauncherStartRequest,
  LauncherSendRequest,
  LauncherStreamRequest,
} from './launcher-command.js';
export type {
  LauncherSetupAction,
  LauncherSetupRequest,
  LauncherSetupResponse,
  LauncherUiSemantics,
  LauncherUiSemanticsContext,
  UiScreenSemantics,
  UiFieldSemantics,
  UiActionSemantics,
  UiStateSemantics,
  UiErrorSemantics,
} from './launcher-setup.js';

// phase 2003 Step E：claw bar 错误行格式化单源（viewport/launcher 共用，纯文本无 ANSI）
export { formatClawBarError } from './claw-bar-display.js';
export type { ClawBarErrorState } from './claw-bar-display.js';
export { MOTION_COMMAND_CATALOG, getMotionCommandSpec } from './motion-command-catalog.js';
export type { MotionCommandId } from './motion-command-catalog.js';
export { CONTRACT_COMMAND_CATALOG, getContractCommandSpec } from './contract-command-catalog.js';
export type { ContractCommandId } from './contract-command-catalog.js';
export { MISC_COMMAND_CATALOG, getMiscCommandSpec } from './misc-command-catalog.js';
export type { MiscCommandId } from './misc-command-catalog.js';
export { shapeCommand } from './command-shape.js';
export { SUBAGENT_COMMAND_CATALOG, getSubagentCommandSpec } from './subagent-command-catalog.js';
export type { SubagentCommandId } from './subagent-command-catalog.js';
export { CONFIG_COMMAND_CATALOG, getConfigCommandSpec } from './config-command-catalog.js';
export type { ConfigCommandId } from './config-command-catalog.js';
export { ROOT_COMMAND_CATALOG, getRootCommandSpec } from './root-command-catalog.js';
export type { RootCommandId } from './root-command-catalog.js';
