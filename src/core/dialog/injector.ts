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
import type { Contract } from '../contract/types.js';
import type { SkillSystem } from '../../foundation/skill-system/index.js';
import type { ContractSystem } from '../contract/index.js';
import { FileNotFoundError } from '../../foundation/fs/types.js';
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

interface CacheEntry {
  mtime: number;
  content: string;
}

/**
 * Injects context into sessions
 */
export class ContextInjector {
  private fs: FileSystem;
  private skillRegistry?: SkillSystem;
  private contractManager?: ContractSystem;
  private audit?: AuditLog;
  private cachedAgentsMd: CacheEntry | null = null;
  private cachedMemoryMd: CacheEntry | null = null;

  constructor(options: ContextInjectorOptions) {
    this.fs = options.fs;
    this.skillRegistry = options.skillRegistry;
    this.contractManager = options.contractManager;
    this.audit = options.audit;
  }

  private async readWithCache(
    path: string,
    cache: CacheEntry | null,
  ): Promise<{ content: string; cache: CacheEntry | null; err?: unknown }> {
    try {
      // Graceful fallback: if fs does not support stat (test mocks), read directly
      if (typeof this.fs.stat !== 'function') {
        const content = await this.fs.read(path);
        return { content, cache: content ? { mtime: 0, content } : cache };
      }
      const stat = await this.fs.stat(path);
      if (cache && cache.mtime === stat.mtime.getTime()) {
        return { content: cache.content, cache };
      }
      const content = await this.fs.read(path);
      return { content, cache: { mtime: stat.mtime.getTime(), content } };
    } catch (err) {
      return { content: '', cache, err };
    }
  }

  /**
   * Build raw parts for system prompt injection
   * Returns individual sections for flexible composition (used by create-runtime helper
   * via buildMotionSystemPrompt — phase 266 reframed MotionRuntime subclass to identity-based dispatch)
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

    // Try to read AGENTS.md (with mtime cache)
    const agentsResult = await this.readWithCache('AGENTS.md', this.cachedAgentsMd);
    this.cachedAgentsMd = agentsResult.cache;
    if (agentsResult.content.trim()) {
      agents = agentsResult.content.trim();
    }
    if (agentsResult.err && !(agentsResult.err instanceof FileNotFoundError)) {
      this.audit?.write(DIALOG_AUDIT_EVENTS.LOAD_FAILED, 'file=AGENTS.md', `reason=${agentsResult.err instanceof Error ? agentsResult.err.message : String(agentsResult.err)}`);
    }

    // Try to read MEMORY.md (with mtime cache)
    const memoryResult = await this.readWithCache('MEMORY.md', this.cachedMemoryMd);
    this.cachedMemoryMd = memoryResult.cache;
    if (memoryResult.content.trim()) {
      memory = '## Memory\n' + memoryResult.content.trim();
    }
    if (memoryResult.err && !(memoryResult.err instanceof FileNotFoundError)) {
      this.audit?.write(DIALOG_AUDIT_EVENTS.LOAD_FAILED, 'file=MEMORY.md', `reason=${memoryResult.err instanceof Error ? memoryResult.err.message : String(memoryResult.err)}`);
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
