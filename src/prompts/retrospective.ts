/**
 * Retrospective Prompt Builder
 *
 * Builds the prompt for contract retrospective subagent.
 */

import type { ClawId } from '../foundation/identity/index.js';
import type { ContractId } from '../core/contract/types.js';


export function buildRetroPrompt(
  clawId: ClawId,
  contractId: ContractId,
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

- **read 工具**：读取目标 claw 的文件时，必须带 \`claw\` 参数：\`{ "path": "clawspace/xxx.md", "claw": "${clawId}" }\`
- **exec 工具**：同样运行在 motion 进程里，不能用来访问其他 claw 的文件系统（ls、cat 等路径均指向 motion 自己的目录）

---

## 复盘步骤

### 第一步：读取执行结果

\`\`\`
clawforum contract log --claw ${clawId} --contract ${contractId}
\`\`\`

查看各 subtask 的最终状态、重试次数、失败原因、验收 evidence。

### 第二步：还原工作过程

\`\`\`
clawforum claw trace --claw ${clawId} --contract ${contractId}
\`\`\`

阅读 claw 的完整工作过程（多轮执行，步骤统一编号 #1, #2, ...），包含每步工具调用的结果摘要。
如某步骤摘要不够，需要看完整输入/输出时：

\`\`\`
clawforum claw trace --claw ${clawId} --contract ${contractId} --step <n>
\`\`\`

### 第三步：评估执行质量

结合上方契约的 background、goal、expectations，判断：
- 各 subtask 执行结果如何？有无多次重试？失败根因是什么？
- 交付物是否达到契约预期的质量？（可用 read + claw 参数查看交付物内容）
- claw 的工作方式是否高效？有无明显浪费或绕路？
- 契约设计本身是否给执行造成了障碍？

### 第四步：提炼 dispatch-skill（如有）
${skillsSummary ? `
**现有 dispatch-skills：**

${skillsSummary}
` : ''}
如果本次执行中发现了值得复用的工作模式，用 write 工具写入 dispatch-skill。

**输出目录**：\`clawspace/dispatch-skills/<skill-name>/\`

如果现有 dispatch-skills 中已有类似的，可以直接更新那个 skill；如果没有，则新建一个。
如果总结出多点内容，可以写进多个 skill，或者写在同一个 skill 的不同部分。

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
  dispatcher 和 claw 都会读这段描述。
  dispatcher 根据它判断"派发这类任务时是否需要安装该 skill"；
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
- \`description\` 同时是 dispatcher 匹配依据和 claw 的使用触发点，必须对两者都清晰
- body 保持简洁，上下文窗口是共享资源

如果执行质量正常、没有特别值得复用的经验，**不需要**强行写 skill。

### 第五步：返回复盘摘要

直接将摘要作为最后一条消息输出（task 系统会自动将其作为结果返回给 motion）。

格式：3-6 行，包含：
- 执行结果（通过/失败，重试情况）
- 关键发现（执行质量、交付物质量、根因）
- 是否写入了新 skill（若有，说明名称和内容方向）`.trim();
}
