/**
 * Retrospective Prompt Builder
 *
 * Builds the prompt for contract retrospective subagent.
 *
 * phase 527: contractId 改 string（templates 是叶子数据层、不反向 import core brand、
 * 消 asset/templates ↔ core/contract pkg 级双向）。
 */


export function buildRetroPrompt(
  clawId: string,
  contractId: string,
  contractYaml: string,
  skillsSummary?: string,
): string {
  return `以下是本次执行的契约（含创建意图和设计）。契约已执行完成，请对本次执行进行复盘。

## 契约
\`\`\`yaml
${contractYaml}
\`\`\`

目标 claw：${clawId}
契约 ID：${contractId}

---

## 运行环境

你运行在 motion 进程里。目标 claw（${clawId}）的文件不在你的工作目录下。

---

## 复盘步骤

### 第一步：读取执行结果

\`\`\`
exec: { "command": "chestnut contract show --claw ${clawId} --contract ${contractId}" }
\`\`\`

查看各 subtask 的最终状态、重试次数、失败原因、验收 evidence。

### 第二步：还原工作过程

\`\`\`
exec: { "command": "chestnut claw ${clawId} trace --contract ${contractId}" }
\`\`\`

阅读 claw 的完整工作过程（多轮执行，步骤统一编号 #1, #2, ...），包含每步工具调用的结果摘要。
如某步骤摘要不够，需要看完整输入/输出时：

\`\`\`
exec: { "command": "chestnut claw ${clawId} trace --contract ${contractId} --step <n>" }
\`\`\`

### 第三步：评估执行质量

结合上方契约的 background、goal、expectations，判断：
- 各 subtask 执行结果如何？有无多次重试？失败根因是什么？
- 交付物是否达到契约预期的质量？（可用 read + claw 参数查看交付物内容）
- claw 的工作方式是否高效？有无明显浪费或绕路？
- 契约设计本身是否给执行造成了障碍？

### 第四步：提炼 dispatch-skill（如有）
${skillsSummary ? `
**现有 dispatch-skills（已发布版本摘要）：**

${skillsSummary}
` : ''}
如果本次执行中发现了值得复用的工作模式，通过**分支编辑事务**提交 dispatch-skill。
不要直接写 dispatch-skills/ 目录——它是版本库的历史投影，直接写入不会成为正式版本。

**编辑工作流**（对每个要新建或更新的 skill 分别进行；多个 skill 必须各自
begin/submit，不得借单技能事务提交跨技能改动）：

1. 开始编辑（reason 会记录为永久依据；来源自动关联本复盘任务，无需手工填写）：

\`\`\`
exec: { "command": "chestnut skill edit begin <skill-name> --reason \"<一句话说明本次经验>\"" }
\`\`\`

   输出包含稳定 editId、Workspace 绝对路径与基准版本。

2. 只在返回的 Workspace 目录内创建/修改文件（SKILL.md 必须，结构见下）；
   不要改动工作区里其他 skill 的目录。

3. 提交：

\`\`\`
exec: { "command": "chestnut skill edit submit <edit-id>" }
\`\`\`

   - 成功：输出 \`published: <version>\`——复盘摘要中引用该 version。
   - 冲突（退出码 3，kind=conflict）：其他任务已发布更新的版本。执行
     \`chestnut skill edit retry <edit-id>\` 取得基于最新版本的新工作区，
     阅读其中的最新内容，把你的经验重新应用进去后再次 submit。
     冲突不是提交成功，不得伪报技能已更新。
   - busy（退出码 4）：重跑同一条 submit 命令续作。
   - 依据缺失（退出码 5，kind=basis_required）：来源任务未能自动关联时发布被
     拒绝（未归因占位身份不能作为发布依据；候选已保留，不会丢失）。用本任务的
     真实身份补依据后重新提交（不得编造任务 id 或他人身份）：

\`\`\`
exec: { "command": "chestnut skill edit basis <edit-id> --actor \"subagent:<你的任务短 id>\" --reason \"<一句话说明本次经验>\" --ref \"subagent-task:<你的任务 id>\"" }
\`\`\`

     然后重跑 \`chestnut skill edit submit <edit-id>\`。basis 命令只补依据，
     不会改动候选内容，也不会自动发布。

如需查看某技能的编辑历史与依据：

\`\`\`
exec: { "command": "chestnut skill history <skill-name>" }
\`\`\`

如果执行中断/超时：工作区与候选版本持久保留，不会丢失；可用
\`chestnut skill edit status <edit-id>\` 查询状态后继续。未发布的候选不算已更新。

#### Skill 结构

\`\`\`
<skill-name>/
├── SKILL.md          必须
└── references/       可选：较长的参考资料，在 SKILL.md 中注明路径和加载时机
\`\`\`

#### SKILL.md 格式

\`\`\`markdown
---
name: skill-name
description: |
  summoner 和 claw 都会读这段描述。
  summoner 根据它判断"派发这类任务时是否需要安装该 skill"；
  claw 根据它判断"当前任务是否适合使用该 skill"。
  要具体说明适用的任务类型和触发场景，例如：
  "适用于需要分析 X 类代码结构的任务。当任务涉及 ... 时使用。"
---

# Skill 标题

## 核心工作流程

（面向 claw 的步骤化工作指南）

## 注意事项

（关键经验、常见陷阱）
\`\`\`

**规则**：
- frontmatter 只能有 \`name\` 和 \`description\` 两个字段
- \`description\` 同时是 summoner 匹配依据和 claw 的使用触发点，必须对两者都清晰
- body 保持简洁，上下文窗口是共享资源

如果执行质量正常、没有特别值得复用的经验，**不需要**强行写 skill，
也不要创建空的编辑任务。

### 第五步：返回复盘摘要

直接将摘要作为最后一条消息输出（task 系统会自动将其作为结果返回给 motion）。

格式：3-6 行，包含：
- 执行结果（通过/失败，重试情况）
- 关键发现（执行质量、交付物质量、根因）
- 是否新建或优化了 skill（若有，说明名称、内容方向和 published version；
  若候选因冲突或中断未发布，明确说明未发布）`.trim();
}
