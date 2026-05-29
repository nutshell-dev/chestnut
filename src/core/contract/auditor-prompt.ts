/**
 * @module L4.ContractSystem
 * phase 1424: contract auditor LLM prompt 模板
 *
 * input 段仅原料（数字 / 命令字面 / 文件路径 / timestamp）。
 * 不预判（"dominant" / "stuck" / "drift" 等主观词不出现在 input）。
 * 主观判断由 auditor 在 output 段产生。
 */

import type { ContractFootprint } from './contract-footprint.js';

export interface AuditorPromptInput {
  contractId: string;
  contractTitle: string;
  expectations: string;
  progress: {
    done: string[];
    in_progress: string | null;
    pending: string[];
  };
  footprint: ContractFootprint;
  recentMessages?: string;
}

export function buildAuditorPrompt(input: AuditorPromptInput): string {
  const { contractId, contractTitle, expectations, progress, footprint, recentMessages } = input;

  const writesSection = footprint.writes.length > 0
    ? footprint.writes.map(w => `  - ${w.file} (${w.bytes}B @ step ${w.step})`).join('\n')
    : '  (none)';

  const editsSection = footprint.edits.length > 0
    ? footprint.edits.map(e => `  - ${e.file} @ step ${e.step}`).join('\n')
    : '  (none)';

  const submitsSection = footprint.submits.length > 0
    ? footprint.submits.map(s => `  - ${s.subtaskId} @ step ${s.step}`).join('\n')
    : '  (none)';

  const readsSection = footprint.reads.length > 0
    ? footprint.reads.slice(0, 20).map(r => `  - ${r.file} @ step ${r.step}`).join('\n')
    : '  (none)';

  const execSection = footprint.execCommands.length > 0
    ? footprint.execCommands.map(c => `  step ${c.step} (exit ${c.exitCode}): ${c.command}`).join('\n')
    : '  (none)';

  const toolCountsSection = Object.entries(footprint.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => `  ${tool}: ${count}`)
    .join('\n');

  return `[contract baseline]
id: ${contractId}
title: ${contractTitle}
expectations:
${expectations}

[contract progress]
done: ${progress.done.join(', ') || '(none)'}
in_progress: ${progress.in_progress || '(none)'}
pending: ${progress.pending.join(', ') || '(none)'}

[canonical activity from audit, step range ${footprint.stepRange[0]}-${footprint.stepRange[1]}]
writes (${footprint.writes.length}):
${writesSection}
edits (${footprint.edits.length}):
${editsSection}
submits (${footprint.submits.length}):
${submitsSection}
spawns: ${footprint.spawns.length}, sends: ${footprint.sends.length}
reads (tool=read, ${footprint.reads.length}):
${readsSection}

[tool counts]
${toolCountsSection || '  (none)'}

[exec commands verbatim, ${footprint.execCommands.length} most recent]
${execSection}
${recentMessages ? `
[recent reasoning, raw]
${recentMessages}
` : ''}
[task]
判定 agent 当前活动是否符合 expectations。注意：
- exec 也用于 cat/head/find/redirect、自行从命令推断真实读/写/搜索行为、不要把 exec 当单一类别
- 若 agent 在合理探索（即使 readonly 多）、应判 on_track
- 仅在明显 drift 时报告（如：agent 引用 expectations 没提的概念 / 跳过 expectations 明确步骤 / 长期无 progress 推进且活动重复）
- drift 反馈附具体证据（step 号 / 文件 / 命令）

输出严格 JSON（无附加文本、无 markdown code fence）：
{
  "on_track": <bool>,
  "drifts": [{"what": "<drift 描述>", "evidence": "<step N / 文件 / 命令片段>"}],
  "next_focus_suggestion": "<给 agent 的开放性建议、自然语言一句话>"
}`;
}
