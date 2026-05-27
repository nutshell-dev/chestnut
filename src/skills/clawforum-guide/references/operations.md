# 系统操作参考

## 访问其他 Claw 的文件

必须带 `claw` 参数，否则访问的是 Motion 自己的目录：

```
ls:     { "path": "contract/archive", "claw": "claw-id" }
read:   { "path": "contract/active/xxx/progress.json", "claw": "claw-id" }
search: { "query": "error", "path": "logs/", "claw": "claw-id" }
```

## Inbox / Outbox 操作规范

向 Claw 发消息：
```
exec: clawforum claw send <claw-id> "<message>"
exec: clawforum claw send <claw-id> "<message>" --priority high
```

查收 Claw outbox：
```
exec: clawforum claw outbox <claw-id>
exec: clawforum claw outbox <claw-id> --limit 5
```

**不要用 `write` 工具直接向 claw inbox 目录写文件**——格式错误，永远不会被处理。`contract create` CLI 已自动发送 inbox 通知，无需额外操作。

## dispatch-skills 目录结构

`clawspace/dispatch-skills/` 存放可复用的契约设计模板，Summoner 在处理任务时自动扫描并按需加载：

```
clawspace/dispatch-skills/
  generate-report/
    SKILL.md   ← frontmatter: name, description + 完整 prompt 模板
  web-research/
    SKILL.md
```

格式与普通 skill 完全一致。没有匹配模板时 Summoner 自行决策，可将结果保存到该目录供下次复用。

> 注：`dispatch-skills/` 目录路径名是 phase 1119 抽离前的历史命名、业务归 SummonSystem own、路径名保留作 legacy。
