# Install And Roles

## 角色

### `manager`

- 部署在管理机
- 提供浏览器控制面板
- 提供管理员登录
- 保存节点目录
- 代理远端 `agent-only`

### `agent-only`

- 部署在目标主机
- 不挂前端页面
- 不提供浏览器登录
- 只暴露本机 API
- 通过 `AGENT_TOKEN` 供 manager 访问

## 安装

### 管理机

```bash
sudo bash scripts/install_manager.sh
```

安装内容：

- Python 运行环境
- `sqlite3`
- `wireguard-tools`
- `nginx` / `certbot`
- `filepanel` 服务用户
- `file-panel` 全局命令
- manager systemd 入口

### 目标主机

```bash
sudo bash scripts/install_agent_only.sh
```

安装内容：

- Python 运行环境
- `sqlite3`
- `wireguard-tools`
- `filepanel` 服务用户
- `file-panel` 全局命令
- agent-only systemd 入口

注意：

- `agent-only` 不会提供浏览器控制面板
- `install_agent_only.sh` 不会自动创建 `wg0`
- WireGuard 接入步骤见 [Node Onboarding And WireGuard](Node-Onboarding-and-WireGuard.md)

## 常用命令

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel uninstall
```

## 更新命令

```bash
file-panel quick
file-panel redeploy
file-panel full-install
```

说明：

- `quick`：只同步代码并重启
- `redeploy`：同步代码和 Python 依赖，再重启
- `full-install`：重新跑安装链，再重启
- 发布通道支持 `stable` / `rc` / `main`
- 新安装默认通道是 `main`
- 如果要让节点切到 `stable` 或 `rc`，远端仓库必须先存在对应分支

这三条命令会根据当前机器保存的 `FILE_PANEL_ROLE` 自动选择 manager 或 agent-only 安装链。
