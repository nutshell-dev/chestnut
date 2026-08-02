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
  getClawCommandSpec,
  type ClawCommandId,
  type ClawInstanceCommandId,
} from './claw-command-catalog.js';
export {
  renderClawInvocation,
  CONTRACT_COMMANDS,
  type ContractCommand,
} from './invocation.js';
export {
  renderClawHelp,
  renderClawCommandHelp,
} from './help.js';
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
} from './guidance.js';
