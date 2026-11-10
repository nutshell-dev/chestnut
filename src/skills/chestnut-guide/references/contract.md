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

脚本从 `clawDir`（`.chestnut/claws/{clawId}/`）运行，用相对路径。脚本退出码为 0 表示验收通过，非零表示验收未通过。

POSIX 主机的 `script_file` 使用 `.sh`，由 `sh` 执行（不要求 Bash 特性）：

```sh
#!/bin/sh
if [ -f "clawspace/<contract-slug>/report.md" ]; then exit 0; else exit 1; fi
```

Windows 主机的 `script_file` 使用 `.cmd` 或 `.bat`，由 `cmd.exe` 执行。路径按 cmd 规则引用：

```bat
@echo off
if exist "clawspace\<contract-slug>\report.md" (exit /b 0) else (exit /b 1)
```

以上 POSIX 与 Windows 示例是**替代关系**：按目标宿主选择其中一种，不要为同一个 subtask 同时配置两条 acceptance。扩展名必须与目标宿主匹配；系统不会模拟另一 OS 的脚本、翻译脚本内容或自动选择 PowerShell，`.ps1` 当前不支持。

不支持的脚本类型或宿主组合会形成 `execution_unavailable`，表示本次无法取得验收结论，不等同于 verifier 否决；超时、启动或 I/O 故障也不应伪装成普通非零退出。

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
ContractSystem 创建契约 → 自动发 inbox 通知给目标 Claw
  → Claw daemon 读取 inbox → 执行 subtask
  → Claw 调用 submit_subtask tool（传入 subtask ID）→ 触发验收
  → 所有 subtask 完成 → 契约归档 → inbox 收到完成通知
```
