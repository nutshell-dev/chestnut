/**
 * ExecContextImpl - Execution context implementation
 * 
 * Provides context for tool execution including:
 * - Identity (clawId, clawDir)
 * - Permissions based on tool profile
 * - Dependencies (fs, monitor, llm)
 * - Execution tracking (stepNumber, elapsed time)
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { Logger } from '../../foundation/monitor/types.js';
import type { LLMService } from '../../foundation/llm/index.js';
import type { ToolProfile } from '../../types/config.js';
import type { ExecContext } from './executor.js';
import { MOTION_CLAW_ID, DEFAULT_MAX_STEPS } from '../../constants.js';


import type { Message } from '../../types/message.js';
import type { Audit } from '../../foundation/audit/index.js';
import type { CallerType } from './caller-type.js';

/**
 * Options for creating execution context
 */
export interface ExecContextImplOptions {
  /** Claw identifier */
  clawId: string;
  
  /** Claw workspace directory */
  clawDir: string;
  
  /** Tool profile for permission control */
  profile: ToolProfile;
  
  /** Caller type for spawn recursion prevention */
  callerType?: CallerType;
  
  /** File system instance */
  fs: FileSystem;
  
  /** Optional monitor for logging */
  monitor?: Logger;
  
  /** Optional LLM service */
  llm?: LLMService;
  
  /** Maximum allowed steps (ReAct loop limit) */
  maxSteps?: number;
  
  /** Optional abort signal */
  signal?: AbortSignal;
  
  
  
  /** Max steps for subagents created via spawn tool */
  subagentMaxSteps?: number;
  
  
  /** 当前对话 messages（供 dispatch 工具读取） */
  dialogMessages?: Message[];
  /** 创建链路的源头 clawId，由 dispatch/spawn 传播 */
  originClawId?: string;
  /** Audit writer for tool events */
  auditWriter?: Audit;
}

/**
 * Execution context implementation
 */
export class ExecContextImpl implements ExecContext {
  clawId: string;
  clawDir: string;
  profile: ToolProfile;
  callerType: CallerType;
  fs: FileSystem;
  monitor?: Logger;
  llm?: LLMService;
  stepNumber: number;
  maxSteps: number;
  signal?: AbortSignal;
  subagentMaxSteps: number;
  dialogMessages?: Message[];
  originClawId?: string;
  auditWriter?: Audit;
  
  private startTime: number;

  constructor(options: ExecContextImplOptions) {
    this.clawId = options.clawId;
    this.clawDir = options.clawDir;
    this.profile = options.profile;
    this.callerType = options.callerType ?? 'claw';
    this.fs = options.fs;
    this.monitor = options.monitor;
    this.llm = options.llm;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.signal = options.signal;
    this.subagentMaxSteps = options.subagentMaxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.dialogMessages = options.dialogMessages;
    this.originClawId = options.originClawId;
    this.auditWriter = options.auditWriter;
    this.stepNumber = 0;
    this.startTime = Date.now();
  }

  /**
   * 是否为 Motion 创建链路上的 agent（Motion 本体或其 subagent）
   */
  get isMotionChain(): boolean {
    return this.clawId === MOTION_CLAW_ID || this.originClawId === MOTION_CLAW_ID;
  }

  /**
   * Get elapsed time since context creation
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Increment step counter
   * Called by ReAct loop before each step
   */
  incrementStep(): void {
    this.stepNumber++;
  }

}
