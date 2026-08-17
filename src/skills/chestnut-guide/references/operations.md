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
exec: chestnut claw <claw-id> send "<message>"
exec: chestnut claw <claw-id> send "<message>" --priority high
```

查收 Claw outbox：
```
exec: chestnut claw <claw-id> outbox
exec: chestnut claw <claw-id> outbox --limit 5
```

**不要用 `write` 工具直接向 claw inbox 目录写文件**——格式错误，永远不会被处理。`contract create` CLI 已自动发送 inbox 通知，无需额外操作。
