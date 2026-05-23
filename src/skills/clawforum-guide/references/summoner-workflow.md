# Summoner 契约创建工作流

Summoner 完成第一阶段推理后，按此流程执行。

## 写契约文件

### 目录结构

```
clawspace/contract-drafts/<contract-slug>/
  contract.yaml
  acceptance/
    <subtask-id>.sh        ← type: script
    <subtask-id>.prompt.txt ← type: llm
```

`<contract-slug>`：kebab-case，描述本次契约内容，如 `pdf-to-markdown-survey`。

### contract.yaml

字段直接来自第一阶段推理结果：

```yaml
schema_version: 1
title: "任务标题（50字以内）"
background: "用户意图：为什么要做这件事（与具体行动无关的动机和背景）"
goal: "要完成什么"
expectations: |
  全局执行要求和质量期望：
  - 用户的约束和偏好
  - 成果质量标准
  - 产出文件路径（若有，例如：clawspace/<contract-slug>/report.md）
subtasks:
  - id: collect-data
    description: "动词 + 做什么，将结果写入 clawspace/<contract-slug>/report.md；含该子任务特有的细化要求"
acceptance:
  - subtask_id: collect-data
    type: llm
    prompt_file: acceptance/collect-data.prompt.txt
escalation:
  max_retries: 3
```

### acceptance/collect-data.prompt.txt

```
检查 clawspace/<contract-slug>/report.md 是否存在且包含……

子任务描述：{{subtask_description}}
完成证据：{{evidence}}
```

可用变量：`{{evidence}}`（submit_subtask 时填写的描述）、`{{subtask_description}}`、`{{artifacts}}`。

**重要**：
- 每个有产出文件的子任务，description 里必须写明路径（`clawspace/<contract-slug>/<文件名>`）。Claw 依赖这个路径决定把文件写到哪里。
- **`subtasks` 必须是数组（`- id: ...` 列表），不能是对象映射**：

  ```yaml
  # ❌ 错误：mapping 格式，系统拒绝（Array.isArray 返回 false）
  subtasks:
    collect-data:
      description: "..."

  # ✅ 正确：array 格式，每项用 - id:
  subtasks:
    - id: collect-data
      description: "..."
  ```

- **禁止把验收条件写在 subtask 内部**（`subtask.acceptance: |` 格式无效，系统不会读取）。验收必须写在顶层 `acceptance` 数组里。
- `type: llm` 必须用 `prompt_file`（指向 acceptance/ 目录下的 .prompt.txt 文件），**不能用 `prompt` 内联文本**——系统会报错。
- `type: script` 用 `script_file`（指向 acceptance/ 目录下的 .sh 文件）。
- prompt 里应包含对产出文件的存在性和内容检查（文件不存在 → 验收不通过）。

详细字段说明和验收规则见 [contract.md](contract.md)。

## 提交契约

```
exec: clawforum contract create --claw <targetClawId> --dir clawspace/contract-drafts/<contract-slug>
```

## 最终回复末尾输出标记（格式不可变）

```
[CONTRACT_DONE]{"contractId":"<id>","targetClaw":"<claw-id>"}[/CONTRACT_DONE]
```
