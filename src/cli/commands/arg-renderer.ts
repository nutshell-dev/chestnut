/**
 * @module L6.CLI.Commands.MessageRenderer.ArgRenderer
 * phase 31 P2.5: arg rendering 函数集。
 */

const POSITIONAL_ARG_MAP: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  Bash: 'command',
  Task: 'description',
  WebFetch: 'url',
  WebSearch: 'query',
  ToolSearch: 'query',
  NotebookEdit: 'notebook_path',
  // chestnut subagent tools
  exec: 'command',
  skill: 'name',
  ask_motion: 'question',
  write: 'path',
  read: 'path',
};

export function truncateSingleLine(s: string, n: number): string {
  const single = s.replace(/\n/g, ' ');
  if (single.length <= n) return single;
  return single.slice(0, n) + '...';
}

function formatValue(v: unknown, maxLen = 40): string {
  if (typeof v === 'string') return `"${truncateSingleLine(v, maxLen)}"`;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  const json = JSON.stringify(v);
  if (json.length <= maxLen) return json;
  return json.slice(0, maxLen) + '...';
}

function formatValueFull(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return JSON.stringify(v, null, 2);
}

export function renderArgs(toolName: string, input: Record<string, unknown>): string {
  const positionalKey = POSITIONAL_ARG_MAP[toolName];
  const parts: string[] = [];

  if (positionalKey && input[positionalKey] !== undefined) {
    parts.push(formatValue(input[positionalKey]));
  }

  for (const [k, v] of Object.entries(input)) {
    if (k === positionalKey) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }

  return `${toolName}(${parts.join(', ')})`;
}

export function renderArgsFull(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const valStr = formatValueFull(v);
    if (!valStr.includes('\n')) {
      parts.push(`${k}: ${valStr}`);
    } else {
      const indented = valStr.split('\n').map(line => `  ${line}`).join('\n');
      parts.push(`${k}:\n${indented}`);
    }
  }
  return parts.join('\n\n');
}
