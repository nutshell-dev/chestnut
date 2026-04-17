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
import type { Message } from '../../types/message.js';
import type { Contract } from '../../types/contract.js';
import type { SessionData } from '../../foundation/session-store/index.js';
import type { SkillRegistry } from '../skill/registry.js';
import type { ContractManager } from '../contract/manager.js';

/**
 * Context injector configuration
 */
export interface ContextInjectorOptions {
  /** File system instance */
  fs: FileSystem;
  /** Skill registry for skill metadata injection */
  skillRegistry?: SkillRegistry;
  /** Contract manager for active contract injection */
  contractManager?: ContractManager;
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
  private skillRegistry?: SkillRegistry;
  private contractManager?: ContractManager;

  constructor(options: ContextInjectorOptions) {
    this.fs = options.fs;
    this.skillRegistry = options.skillRegistry;
    this.contractManager = options.contractManager;
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
    } catch {
      // AGENTS.md doesn't exist, skip silently
    }

    // Try to read MEMORY.md
    try {
      const content = await this.fs.read('MEMORY.md');
      if (content.trim()) {
        memory = '## Memory\n' + content.trim();
      }
    } catch {
      // MEMORY.md doesn't exist, skip
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
      } catch {
        // No active contract or error loading, skip
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
}
