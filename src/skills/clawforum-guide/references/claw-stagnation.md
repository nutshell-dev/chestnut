# Claw 停滞处理参考

## 诊断步骤

```
clawforum contract log --claw <claw-id>
clawforum claw <claw-id> trace --contract <contract-id>
```

- `contract log`：看哪些 subtask 仍是 todo
- `claw <claw-id> trace`：看 claw 最后做了什么，最后一步是工具调用还是纯文字回复

## 决策规则

| 情况 | 行动 |
|------|------|
| `status: stopped` 且有契约 | 重启：`clawforum claw <claw-id> daemon` |
| `outbox_pending > 0` | 先查收：`clawforum claw <claw-id> outbox` |
| notification #N >= 3 | 不干预，摘要里说明，让 Motion 上报用户 |
| `inactive` 且有 todo subtask | 发 inbox 消息（见下方模板） |
| `running` 且无 todo subtask | 正在执行中，无需干预 |

## Session 结束但契约未完成

**症状**：Claw 变为 `inactive`（daemon 在运行但 agent session 已结束），trace 最后是纯文字回复而非工具调用，contract 有 todo subtask。

**原因**：Agent 在某轮 session 结束时只输出了文字，没有调用 `write` 工具写文件、没有调用 `submit_subtask` 工具提交，session 正常退出但工作未完成。

**处理**：发 inbox 消息推动继续。消息须包含：
1. 明确指出哪个 subtask 还是 todo
2. 强调必须用 `write` 工具把产出写入文件（不能只在回复里输出文字）
3. 写完后必须调用 `submit_subtask` 工具提交

```
clawforum claw <claw-id> send "请继续完成 <subtask-id> 子任务。必须用 write 工具把产出写入 clawspace/<contract-slug>/<文件名>，不要只在回复里输出文字。写完后调用 submit_subtask 工具提交。"
```

发了 2 次消息后 trace 仍无新步骤 → claw 上下文可能已混乱，在摘要里说明，让 Motion 用 spawn 另起子代理完成剩余工作。
