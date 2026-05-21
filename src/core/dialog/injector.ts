/**
 * ContextInjector - Injects fixed prefixes into conversation context
 * 
 * Injects (in order):
 * 1. AGENTS.md (system prompt base)
 * 2. MEMORY.md (persistent memory)
 * 3. Active contract summaries (if any)
 * 4. Skill metadata (if any)
 * 5. Tool definitions (via ToolRegistry - Phase 1)
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { Message } from '../../foundation/llm-provider/types.js';
import type { Contract } from '../contract/types.js';
import type { SessionData } from '../../foundation/dialog-store/index.js';
import type { SkillSystem } from '../../foundation/skill-system/index.js';
import type { ContractSystem } from '../contract/index.js';
import { FileNotFoundError } from '../../types/index.js';
import { DIALOG_AUDIT_EVENTS } from '../../foundation/dialog-store/audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';

/**
 * Context injector configuration
 */
export interface ContextInjectorOptions {
  /** File system instance */
  fs: FileSystem;
  /** Skill registry for skill metadata injection */
  skillRegistry?: SkillSystem;
  /** Contract manager for active contract injection */
  contractManager?: ContractSystem;
  /** Optional audit writer / phase 646 ⚓ context load failure audit (FNF silent / else audit) */
  audit?: AuditLog;
}

/**
 * Format contract for prompt injection
 * Returns markdown with title, goal, and subtask progress
 */
function formatContractForPrompt(contract: Contract): string {
  const lines = [
    '## Active Contract',
    `**Title:** ${contract.title}`,
    `**Goal:** ${contract.goal}`,
    '',
    '**Subtasks:**',
  ];

  for (const subtask of contract.subtasks) {
    const checkbox = subtask.status === 'completed' ? '[x]' : '[ ]';
    lines.push(`${checkbox} \`${subtask.id}\`: ${subtask.description}`);
  }

  return lines.join('\n');
}

/**
 * Injects context into sessions
 */
export class ContextInjector {
  private fs: FileSystem;
  private skillRegistry?: SkillSystem;
  private contractManager?: ContractSystem;
  private audit?: AuditLog;

  constructor(options: ContextInjectorOptions) {
    this.fs = options.fs;
    this.skillRegistry = options.skillRegistry;
    this.contractManager = options.contractManager;
    this.audit = options.audit;
  }

  /**
   * Build raw parts for system prompt injection
   * Returns individual sections for flexible composition (used by MotionRuntime)
   */
  async buildParts(): Promise<{
    agents: string;
    memory: string;
    skills: string;
    contract: string;
  }> {
    let agents = '';
    let memory = '';
    let skills = '';
    let contract = '';

    // Try to read AGENTS.md
    try {
      const content = await this.fs.read('AGENTS.md');
      if (content.trim()) {
        agents = content.trim();
      }
    } catch (err) {
      // FNF silent OK / else audit (phase 646 D2 align)
      if (!(err instanceof FileNotFoundError)) {
        this.audit?.write(DIALOG_AUDIT_EVENTS.LOAD_FAILED, 'file=AGENTS.md', `reason=${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Try to read MEMORY.md
    try {
      const content = await this.fs.read('MEMORY.md');
      if (content.trim()) {
        memory = '## Memory\n' + content.trim();
      }
    } catch (err) {
      // FNF silent OK / else audit (phase 646 D2 align)
      if (!(err instanceof FileNotFoundError)) {
        this.audit?.write(DIALOG_AUDIT_EVENTS.LOAD_FAILED, 'file=MEMORY.md', `reason=${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Inject skill metadata if available
    if (this.skillRegistry) {
      const skillContext = this.skillRegistry.formatForContext();
      if (skillContext) {
        skills = skillContext;
      }
    }

    // Inject active contract if available
    if (this.contractManager) {
      try {
        const contractData = await this.contractManager.loadActive();
        if (contractData) {
          contract = formatContractForPrompt(contractData);
        }
      } catch (err) {
        // FNF silent OK / else audit (phase 646 D2 align)
        if (!(err instanceof FileNotFoundError)) {
          this.audit?.write(DIALOG_AUDIT_EVENTS.LOAD_FAILED, 'file=contract', `reason=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { agents, memory, skills, contract };
  }

  /**
   * Build system prompt from AGENTS.md, MEMORY.md, skills, and active contract
   * Gracefully degrades if files don't exist
   */
  async buildSystemPrompt(): Promise<string> {
    const parts = await this.buildParts();
    const sections: string[] = [];
    
    if (parts.agents) sections.push(parts.agents);
    if (parts.memory) sections.push(parts.memory);
    if (parts.skills) sections.push(parts.skills);
    if (parts.contract) sections.push(parts.contract);

    return sections.join('\n\n');
  }

  /**
   * Build system prompt for regime switch detection.
   * Returns both the full prompt and the identity hash (agents + skills only).
   * identityContent excludes dynamic parts (memory, contract) so that only
   * identity-layer changes trigger regime switches.
   */
  async buildSystemPromptForRegime(): Promise<{ full: string; identityContent: string }> {
    const parts = await this.buildParts();
    const sections: string[] = [];
    if (parts.agents) sections.push(parts.agents);
    if (parts.memory) sections.push(parts.memory);
    if (parts.skills) sections.push(parts.skills);
    if (parts.contract) sections.push(parts.contract);
    const full = sections.join('\n\n');

    // identity = 身份层（agents + skills）/ memory + contract = 动态层不入
    const identity = [parts.agents, parts.skills].filter(Boolean).join('\n\n');

    return { full, identityContent: identity };
  }
}

/**
 * Factory: createContextInjector
 * 装配期构造 ContextInjector / 承 phase212 D.1 工厂模板.
 */
export function createContextInjector(opts: ContextInjectorOptions): ContextInjector {
  return new ContextInjector(opts);
}
