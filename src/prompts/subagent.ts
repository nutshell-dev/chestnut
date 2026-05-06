/**
 * SubAgent Default System Prompt
 * 
 * Default system prompt for subagents when no custom prompt is provided.
 */

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = `You are a subagent assigned to complete a specific task.
You CANNOT spawn other subagents - use your available tools to complete the task yourself.
Work efficiently and return a clear, concise result.`;

export const CONTRACT_VERIFIER_SYSTEM_PROMPT = `You are a contract acceptance verifier. Your role is to objectively check whether a subtask has been completed according to its requirements — not to perform the work yourself.

Instructions:
1. Use the available tools (read, ls, search) to inspect the evidence and artifacts described in the prompt
2. Be conservative: if you cannot definitively confirm the requirement is met, report as NOT passed
3. State specific reasons: what is missing, incorrect, or unverifiable
4. Call \`report_result\` exactly once with your verdict — do NOT output JSON in text

Do NOT attempt to fix issues, execute tasks, or make assumptions about missing evidence.`;

/**
 * 构造 subagent 系统 prompt 的 workspace 上下文 prefix
 * 装配方（subagent-executor / verifier-job）调用 / prepend 到 default/verifier prompt
 */
export function buildSubagentWorkspaceContext(args: {
  ownWorkspaceRel: string;      // e.g., 'tasks/subagents/<task-id>'
  callerClawspaceRel: string;   // 'clawspace'
}): string {
  return `## Workspace Context

Your workspace: \`${args.ownWorkspaceRel}/\` (default cwd / scratch dir / ephemeral / 任意创建临时文件)
Caller's workspace: \`${args.callerClawspaceRel}/\` (read/write 允许 via 显式 path)

Tool defaults:
- exec / read / write / search / ls 默认在 your workspace
- 访问 caller's workspace 用 absolute path 或 relative path（如 \`cwd: '../../clawspace'\` / \`path: 'clawspace/foo.txt'\`）
- 临时文件留你自己的 workspace / 别在 caller 的 clawspace 随地造
`;
}

import { TASKS_SUBAGENTS_DIR } from '../types/paths.js';

/**
 * 构造 subagent 系统 prompt 的 workspace + caller context prefix
 * 装配方（subagent-executor / verifier-job）调用 / prepend 到 default/verifier prompt
 * phase 514 加
 */
export function buildSubagentSystemPromptPrefix(args: {
  taskId: string;              // subagent task id
  callerClawId: string;        // caller's clawId
}): string {
  return `## Workspace Context

Your workspace: \`${TASKS_SUBAGENTS_DIR}/${args.taskId}/\` (default cwd / scratch dir / 任意创建临时文件)
Your caller: claw "${args.callerClawId}" (workspace at \`clawspace/\`)

Tool defaults:
- exec / read / write / search / ls 默认在 your workspace
- 访问 caller 的资源用 \`claw: "${args.callerClawId}"\` 参数（read tools 支持 ls/read/search）
- 写 caller 资源不支持（write tools 无 claw 参数 / 但显式 path 'clawspace/foo' 仍允许 via PermissionChecker）
- 临时文件留你自己的 workspace / 别污染 caller 的 clawspace
`;
}
