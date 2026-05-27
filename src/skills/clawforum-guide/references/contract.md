# 契约系统参考

## YAML 格式

```yaml
schema_version: 1
title: "任务标题（50字以内）"
background: "用户意图：为什么要做这件事（与具体行动无关的动机和背景）"
goal: "描述这份契约要达成的目标"
expectations: |
  全局执行要求和质量期望：
  - 用户的约束和偏好
  - 成果质量标准
  - 预期产出路径（如有交付物）
subtasks:
  - id: collect-data
    description: "动词 + 做什么 + 具体输出路径（用 clawspace/<contract-slug>/ 子目录），含该子任务特有的细化要求"
  - id: write-report
    description: "基于收集的数据撰写报告，保存到 clawspace/<contract-slug>/report.md"
acceptance:
  - subtask_id: collect-data
    type: script
    script_file: acceptance/collect-data.sh
  - subtask_id: write-report
    type: llm
    prompt_file: acceptance/write-report.prompt.txt
escalation:
  max_retries: 3
```

## 字段说明

- `background`：用户意图，与具体行动无关的动机和背景
- `goal`：本次契约要达成的目标（要做什么）
- `expectations`：全局执行要求和质量期望，适用于所有子任务；若有交付物，在此注明预期路径
- `subtasks[].description`：该子任务的具体行动，含特有的细化要求；产出文件用 `clawspace/<contract-slug>/` 子目录

## Subtask ID 命名规范

用动词短语（kebab-case）：`collect-data`、`write-report`、`analyze-logs`。
不要用 `subtask-1`、`task-a`、`step1`——Claw 用 `submit_subtask` tool 时传入这个 ID，必须直观。

## 验收规则

- `acceptance[]` 与 `subtasks[]` 平级，通过 `subtask_id` 对应
- 每个 `subtask_id` 在 `acceptance` 里只能出现一次（写两条只有第一条生效）
- `type: script` 对应 `script_file`；`type: llm` 对应 `prompt_file`，不可混用
- **优先用 script**：能客观检查的（文件存在、字数、格式）一律用 script；只有无法用脚本验证质量时才用 llm

### 验收脚本示例

脚本从 `clawDir`（`.clawforum/claws/{clawId}/`）运行，用相对路径：

```bash
#!/bin/bash
if [ -f "clawspace/<contract-slug>/report.md" ]; then exit 0; else exit 1; fi
```

### LLM 验收提示词示例

必须包含 `{{evidence}}` 和 `{{artifacts}}` 占位符：

```
请判断以下 subtask 是否完成。

验收标准：clawspace/<contract-slug>/report.md 存在且包含完整分析

{{evidence}}

{{artifacts}}

回复格式（JSON）：{"passed": true/false, "reason": "一句话说明"}
```

## 契约生命周期

```
summon 创建契约 → contract create CLI（自动发 inbox 通知给目标 Claw）
  → Claw daemon 读取 inbox → 执行 subtask
  → Claw 调用 submit_subtask tool（传入 subtask ID）→ 触发验收
  → 所有 subtask 完成 → 契约归档 → inbox 收到完成通知
```
