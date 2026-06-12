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

  task += `\n\n**重要协议约束**：
1. 你**绝不能**绕过 Step 4 的 \`chestnut contract create\` 自跑任务实际工作。
   唯一成功证据 = \`chestnut contract create\` CLI 返 \`Contract created: <id> for claw <name>\` 行。
   post-processor 扫子代理 audit 找这一行、找不到判 SUMMON_SHADOW_FAILED。

## 角色边界

你的唯一角色 = **为目标 claw 设计契约 + 提交 \`chestnut contract create\`**。

你不是 target claw、不是执行者：

- 你**不能**自己跑 goal 描述的实际任务工作（如 goal 说「核查 X」、你不能自己 grep X）
- 你**不能**自己写 goal 期望的产出文件（如 goal 说「写报告」、你不能自己 write 报告）
- 你**不能**用 raw output 文本「假装」任务完成（post-processor 用 audit 系统真相判、不读你的输出文本）

你**应该**做：

- 调 \`chestnut claw list\` 确认 target claw 在 daemon 状态
- 设计 contract.yaml（含 goal/expectations/subtasks）
- 写到 \`./contract-drafts/<slug>/\`
- 调 \`chestnut contract create --claw <id> --dir <path>\` 提交契约

提交后、target claw 由 dispatcher 派活、收 contract、跑 subtask、完成后通过 contract_completed 事件触 retro。整个执行链你不参与。

**关键边界（phase 119）**：

你**只能**为本次 summon 指定的 target_claw 创建契约。即使你跑 \`chestnut claw list\`
看到别的 claw 缺契约、跑 daemon 没起、或任何"系统状态不完整"
的信号——**也不要补**。

补别人的缺 = **越界违规**：
- 用户没让你做、motion 没派你做、你不知道补的契约是不是用户要的
- 系统 gate 会校验 \`--claw <X>\` 必须等于 SummonDecision.targetClaw、不等 throw SUMMON_TARGET_CLAW_VIOLATION
- 若 sibling 子代理在做别的 claw、各 sibling 各自负责自己的、不需要你帮忙

只关注 target_claw、不补缺=合规。

## 执行步骤

### 1. 确定目标 claw`;

  if (targetClaw) {
    task += `
目标 claw 已由用户指定：**${targetClaw}**。
执行 \`chestnut claw list\` 确认它存在且处于 daemon 状态。
如未运行，执行：
  exec: chestnut claw ${targetClaw} daemon
  exec: chestnut claw list   ← 再次确认状态已变为 running，再继续`;
  } else {
    task += `
用 \`chestnut claw list\` 查现有 claw，判断复用还是新建：
- 判断依据：上下文效率，不根据 claw 名称推断能力
- 如果现有 claw 的对话状态专注于不同的项目或任务域，应新建 claw
- 如需新建：
  exec: chestnut claw <name> create
  exec: chestnut claw <name> daemon
  exec: chestnut claw list   ← 确认 daemon 已运行再继续
- targetClaw 必须是 claw id（kebab-case），不能是 UUID 或 taskId`;
  }

  task += `

### 2. 安装 dispatch 模板（如需要）

**两类技能池，定位不同：**
- \`scope: "self"\`：Motion 自己用的技能（如 \`chestnut-guide\`）
- \`scope: "dispatch"\`：可安装到 claw 的任务模板，摘要已在上方列出

如需查看某个 dispatch 模板的完整内容：
skill: { "name": "<skill-name>", "scope": "dispatch" }

如需将 dispatch 模板安装到目标 claw：
exec: chestnut skill install --claw <id> --skill <name>

**注意**：直接调用 \`skill: { "name": "..." }\`（不带 \`scope\`，默认 \`scope: "self"\`）只查 Motion 自己的 self 池，找不到 dispatch 模板。

### 3. 写契约文件
`;

  task += verify ? buildVerifyTrueWriteSection() : buildVerifyFalseWriteSection();

  task += `

### 4. 提交契约
exec: chestnut contract create --claw <targetClawId> --dir ./contract-drafts/<contract-slug>

CLI 成功返回 \`Contract created: <id> for claw <claw-id>\` 即视为本次任务完成、可直接 \`done(result="<给 Motion 的简报>")\` 退出。系统按 subagent audit 真相自动登记 retro、无需在 result 内附加任何特殊标记。

**任何其他执行路径**（包括跳过 Step 4 自己跑 grep/write/exec 完成任务的实际工作）**都不算成功完成**，会被 post-processor 判 SUMMON_SHADOW_FAILED。

---

### background / expectations 写法指引

- **background**：用户意图，与具体行动无关的动机和背景。从对话上下文综合提炼，不是对任务的描述。
- **expectations**：全局执行要求和质量期望，适用于所有子任务。包含：用户约束和偏好（显性 + 推断）、成果质量标准、预期产出路径（如有交付物）。`;

  return task;
}

function buildVerifyTrueWriteSection(): string {
  return `目录结构：
\`\`\`
./contract-drafts/<contract-slug>/
  contract.yaml
  verification/
    <subtask-id>.prompt.txt  ← type: llm
    <subtask-id>.sh          ← type: script
\`\`\`

\`<contract-slug>\`：kebab-case，描述本次契约内容，如 \`pdf-to-markdown-survey\`。

**contract.yaml 格式**：
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
verification:
  - subtask_id: <subtask-id>
    type: llm
    prompt_file: verification/<subtask-id>.prompt.txt
escalation:
  max_retries: 3
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
- 每个有产出文件的子任务，description 里必须写明路径（Claw 依赖此路径决定文件写到哪里）`;
}

function buildVerifyFalseWriteSection(): string {
  return `目录结构：
\`\`\`
./contract-drafts/<contract-slug>/
  contract.yaml
\`\`\`

\`<contract-slug>\`：kebab-case，描述本次契约内容。

**contract.yaml 格式**：
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
    auth_level: auto
\`\`\`

**关键规则**：
- \`subtasks\` 必须是数组（\`- id: ...\` 列表），不能是对象映射（\`<subtask-id>: { description: ... }\` 格式系统拒绝）
- 每个有产出文件的子任务，description 里必须写明路径（Claw 依赖此路径决定文件写到哪里）

**verify=false 行为承诺**：
本契约 verify=false（默认）—— 子任务 claw 调 submit_subtask 即立即标 completed，不经过 verification 门控。
**禁止在 contract.yaml 写 \`verification:\` / \`escalation:\` 字段**。CLI gate 会在 contract create 时拒带这些字段的契约（错误：SUMMON_VERIFY_FALSE_VIOLATION）。如确需 verification 门控，summon 调用方须显式传 \`verify: true\`。`;
}
