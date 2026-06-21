/**
 * @module L6.CLI.Registry
 *
 * phase 554: typed CLI command surface 迁出至 foundation/utils/cli-commands、消 6 assembly→cli 反向 import。
 * 本文件保 re-export、不动 cli 自家 callsite import path。
 */
export {
  CLAW_VERBS,
  clawCmd,
  CONTRACT_COMMANDS,
} from '../../foundation/utils/cli-commands.js';
export type { ClawVerb, ContractCommand } from '../../foundation/utils/cli-commands.js';
