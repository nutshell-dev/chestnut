# 契约创建完整工作流

本文档供 summon subagent 使用。完成以下各阶段后输出 [CONTRACT_DONE] 标记。

---

## 第一阶段：推理

在动手之前，先完成以下推理。**第二阶段必须从工具调用开始，不得跳过推理直接输出结果。**

**用户意图（background）**
为什么要做这件事？与具体行动无关的动机和背景。

**任务目标（goal）**
要完成什么？

**全局要求与质量期望（expectations）**
用户的约束和偏好（显性 + 推断）、成果质量标准、预期产出路径（如有）。
不要遗漏用户在对话里表达过的要求。

**子任务拆分**
拆成哪几个子任务？每个子任务做什么、产出到 `clawspace/<contract-slug>/` 哪个路径？

---

## 第二阶段：执行

### 1. 确定目标 claw

```
exec: clawforum claw list
```

根据输出判断复用还是新建：
- **复用**：选择对话状态与本次任务相关的 claw
- **新建**：现有 claw 专注于不同项目或任务域时
  ```
  exec: clawforum claw create <name>
  exec: clawforum claw daemon <name>
  exec: clawforum claw list   ← 确认 daemon 已运行再继续
  ```
- targetClaw 必须是 claw id（kebab-case），不能是 UUID 或 taskId
- 若 targetClaw 已由上游指定，执行 `claw list` 确认其存在且处于 running 状态；未运行则先启动

### 2. 安装 dispatch-skills（如需要）

dispatch-skills 摘要已在你的上下文中列出（若有）。

查看某个 dispatch-skill 的完整内容：
```
skill: { "name": "<skill-name>", "skillsDir": "clawspace/dispatch-skills" }
```

将 dispatch-skill 安装到目标 claw：
```
exec: clawforum skill install --claw <id> --skill <name>
```

注意：直接调用 `skill: { "name": "..." }`（不带 `skillsDir`）只查 Motion 自己的 `skills/`，找不到 dispatch-skill。

### 3. 写契约文件

目录结构：
```
clawspace/contract-drafts/<contract-slug>/
  contract.yaml
  acceptance/
    <subtask-id>.prompt.txt  ← type: llm
    <subtask-id>.sh          ← type: script
```

`<contract-slug>`：kebab-case，描述本次契约内容，如 `pdf-to-markdown-survey`。

契约文件格式和验收规则详见 [contract.md](contract.md)。

**重要规则**：
- `subtasks` 必须是数组（`- id: ...` 列表），不能是对象映射
- 验收条件写在顶层 `acceptance` 数组，不能写在 subtask 内部
- `type: llm` 用 `prompt_file`；`type: script` 用 `script_file`；不可混用
- 每个有产出文件的 subtask，description 里必须写明路径（Claw 依赖此路径决定写到哪里）

### 4. 提交契约

```
exec: clawforum contract create --claw <targetClawId> --dir clawspace/contract-drafts/<contract-slug>
```

### 5. 在最终回复末尾输出（格式不可变）

```
[CONTRACT_DONE]{"contractId":"<id>","targetClaw":"<claw-id>"}[/CONTRACT_DONE]
```
