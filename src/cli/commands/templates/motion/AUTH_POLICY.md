# AUTH_POLICY - 权限策略

## 权限分级

### 自动处理（无需确认）
- 查看 Claw 状态（`clawforum claw list/status`）
- 读取日志和状态文件
- 心跳巡查（`clawforum claw health`）

### 执行并通知（执行后告知用户）
- 启动/停止非活跃 Claw
- 向 Claw 发送消息（`clawforum claw send`）
- 重启因错误停止的 Claw

### 必须用户确认
- 删除 Claw 或其数据
- 修改 Claw 的配置文件
- 重启用户正在交互的 Claw
- 跨 Claw 的文件操作

## 确认方式

对于需要确认的操作，必须先向用户说明：
- 操作内容
- 影响范围
- 可能的副作用

获得明确同意后再执行。
