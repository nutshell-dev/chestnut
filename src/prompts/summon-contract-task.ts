/**
 * Summon Contract Task Builder
 * phase 1142 rename from describing.ts、删身份混淆段（身份锚定归 shadow-system buildShadowInstruction）
 *
 * Builds the task body for summon shadow mode subagent (contract creation workflow).
 * 不含身份段；身份锚由 ShadowSystem.buildShadowInstruction wrap。
 */


export function buildSummonContractTask(
  goal: string,
  skillsSummary?: string,
  targetClaw?: string,
  opts: { verify?: boolean } = {},
): string {
  const verify = opts.verify === true;
  let task = `## 本次目标\n${goal}`;

  if (skillsSummary) {
    task += `\n\n${skillsSummary}`;
  }

  task += `\n\n**重要**：第二阶段必须从工具调用开始，不得跳过任何步骤直接输出结果标记。

## 第一阶段：推理

请先进行以下推理：

**用户意图（background）**
为什么要做这件事？与具体行动无关的动机和背景。

**任务目标（goal）**
要完成什么？（可直接引用本次目标）

**全局要求与质量期望（expectations）**
用户的约束和偏好（显性的 + 推断的）、成果质量标准、预期产出路径（如有）。
不要遗漏用户在对话里表达过的要求。

**子任务拆分**
拆成哪几个子任务？每个子任务做什么、产出到哪个路径？

## 第二阶段：执行

推理完成后，按顺序执行：

### 1. 确定目标 claw`;

  if (targetClaw) {
    task += `
目标 claw 已由用户指定：**${targetClaw}**。
执行 \`clawforum claw list\` 确认它存在且处于 daemon 状态。
如未运行，执行：
  exec: clawforum claw daemon ${targetClaw}
  exec: clawforum claw list   ← 再次确认状态已变为 running，再继续`;
  } else {
    task += `
用 \`clawforum claw list\` 查现有 claw，判断复用还是新建：
- 判断依据：上下文效率，不根据 claw 名称推断能力
- 如果现有 claw 的对话状态专注于不同的项目或任务域，应新建 claw
- 如需新建：
  exec: clawforum claw create <name>
  exec: clawforum claw daemon <name>
  exec: clawforum claw list   ← 确认 daemon 已运行再继续
- targetClaw 必须是 claw id（kebab-case），不能是 UUID 或 taskId`;
  }

  task += `

### 2. 安装 dispatch 模板（如需要）

**两类技能池，定位不同：**
- \`scope: "self"\`：Motion 自己用的技能（如 \`clawforum-guide\`）
- \`scope: "dispatch"\`：可安装到 claw 的任务模板，摘要已在上方列出

如需查看某个 dispatch 模板的完整内容：
skill: { "name": "<skill-name>", "scope": "dispatch" }

如需将 dispatch 模板安装到目标 claw：
exec: clawforum skill install --claw <id> --skill <name>

**注意**：直接调用 \`skill: { "name": "..." }\`（不带 \`scope\`，默认 \`scope: "self"\`）只查 Motion 自己的 self 池，找不到 dispatch 模板。

### 3. 写契约文件

目录结构：
\`\`\`
./contract-drafts/<contract-slug>/
  contract.yaml
  verification/
    <subtask-id>.prompt.txt  ← type: llm
    <subtask-id>.sh          ← type: script
\`\`\`

\`<contract-slug>\`：kebab-case，描述本次契约内容，如 \`pdf-to-markdown-survey\`。

**contract.yaml 格式**（字段来自第一阶段推理）：
\`\`\`yaml
schema_version: 1
title: "任务标题（50字以内）"
background: "用户意图：为什么要做这件事（与具体行动无关的动机和背景）"
goal: "要完成什么"
expectations: |
  全局执行要求和质量期望：
  - 用户的约束和偏好
  - 成果质量标准
  - 产出文件路径（若有，例如：<contract-slug>/report.md）
subtasks:
  - id: <subtask-id>
    description: "动词 + 做什么，将结果写入 <contract-slug>/<file>；含该子任务特有的细化要求"
${verify ? `verification:
  - subtask_id: <subtask-id>
    type: llm
    prompt_file: verification/<subtask-id>.prompt.txt
escalation:
  max_retries: 3` : `> 注：本契约 verify=false（默认），子任务 claw 调 submit_subtask 即立即标 completed，不经过 verification 门控。`}
\`\`\`

**verification/.prompt.txt 格式**（type: llm 时）：
\`\`\`
检查 <contract-slug>/<file> 是否存在且包含……

子任务描述：{{subtask_description}}
完成证据：{{evidence}}
\`\`\`

可用变量：\`{{evidence}}\`（submit_subtask 时填写的描述）、\`{{subtask_description}}\`、\`{{artifacts}}\`。

**关键规则**：
- \`subtasks\` 必须是数组（\`- id: ...\` 列表），不能是对象映射（\`<subtask-id>: { description: ... }\` 格式系统拒绝）
- 验证条件不能写在 subtask 内部，必须写在顶层 \`verification\` 数组里
- \`type: llm\` 必须用 \`prompt_file\`（指向 verification/ 目录下的 .prompt.txt），不能用 \`prompt\` 内联文本
- \`type: script\` 用 \`script_file\`（指向 verification/ 目录下的 .sh 文件）
- 每个有产出文件的子任务，description 里必须写明路径（Claw 依赖此路径决定文件写到哪里）

### 4. 提交契约
exec: clawforum contract create --claw <targetClawId> --dir ./contract-drafts/<contract-slug>

CLI 成功返回 \`Contract created: <id> for claw <claw-id>\` 即视为本次任务完成、可直接 \`done(result="<给 Motion 的简报>")\` 退出。系统按 subagent audit 真相自动登记 retro、无需在 result 内附加任何特殊标记。

---

### background / expectations 写法指引

- **background**：用户意图，与具体行动无关的动机和背景。从对话上下文综合提炼，不是对任务的描述。
- **expectations**：全局执行要求和质量期望，适用于所有子任务。包含：用户约束和偏好（显性 + 推断）、成果质量标准、预期产出路径（如有交付物）。`;

  return task;
}
