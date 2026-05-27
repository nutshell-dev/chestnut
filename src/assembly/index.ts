/**
 * @module L6.Assembly
 * Assembly — 运行时依赖组装与注入。
 */

export { LockConflictError } from '../foundation/process-manager/index.js';
export type { Identity, AssembleConfig, Instances } from './types.js';

export { assemble } from './assemble.js';
export { disassemble } from './disassemble.js';
