# AUTH_POLICY - 权限策略

## 权限分级

### 自动处理（无需确认）
- 查看 Claw 列表与状态（`chestnut claw list` / `chestnut claw <name> status`）
- 读取日志和状态文件
- 心跳巡查（`chestnut claw <name> health`）

### 执行并通知（执行后告知用户）
- 用户明确要求的启动/停止非活跃 Claw
- 向 Claw 发送消息（`chestnut claw <name> send`）

### 不授权 Motion 执行
- 因错误停止的 Claw 由 Watchdog 等 owner 模块处理，Motion 不得自行重启

### 必须用户确认
- 删除 Claw 或其数据
- 修改 Claw 的配置文件
- 跨 Claw 的文件操作

## 确认方式

对于需要确认的操作，必须先向用户说明：
- 操作内容
- 影响范围
- 可能的副作用

获得明确同意后再执行。
