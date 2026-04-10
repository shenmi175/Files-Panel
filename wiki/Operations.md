# Operations

## 登录与认证

- 浏览器登录只在 `manager` 启用
- 首次访问先注册本地管理员账号
- 登录后由服务端签发 `HttpOnly` 会话 Cookie
- `AGENT_TOKEN` 不再作为浏览器登录密码

## 主要页面

### 概览

- 查看当前值卡片
- 查看 `1m / 5m` 平滑值
- 查看趋势图
- 查看 Docker、网卡、磁盘分项

### 文件

- 浏览 `AGENT_ROOT` 范围内的文件
- 上传、下载、重命名、删除、创建目录
- `系统只读` 模式只允许列目录和下载

### 接入与配置

- 查看当前监听与目标监听
- 配置域名和 HTTPS
- 修改端口、`AGENT_ROOT`、采样间隔
- 重置 `AGENT_TOKEN`

### 节点

- 保存远程节点 URL
- 保存 WireGuard IP
- 保存远程节点 Token
- 切换查看远端节点

### 日志

- 查看当前节点的 systemd 日志
- 按级别过滤
- 用于排查 agent 或 manager 启动失败

## 常见运维动作

### 查看服务

```bash
file-panel status
file-panel logs 120
```

### 查看本机接入信息

```bash
file-panel info
```

### 更新当前节点

- 先在“自动更新”卡片里选择发布通道：`stable` / `rc` / `main`
- 面板里支持 `quick` / `redeploy` / `full-install`
- 命令行也支持对应的 `file-panel quick|redeploy|full-install`
- 如果所选通道还没有发布到远端仓库，面板会显示“通道未发布”

## 常见排查入口

### agent 切换后显示 `Connection refused`

优先检查：

```bash
systemctl status files-agent --no-pager
journalctl -u files-agent -n 80 --no-pager
curl -s http://127.0.0.1:3000/api/health
```

### WireGuard 已有地址，但节点仍不可达

继续检查：

```bash
wg show
ip -4 addr show wg0
curl -sv http://<wireguard-ip>:3000/api/health
```
