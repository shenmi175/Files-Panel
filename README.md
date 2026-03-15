# File Panel

`File Panel` 现在拆成两种运行角色：

- `manager`：部署在管理机，提供浏览器控制面板、管理员账号密码登录、节点目录和远端代理。
- `agent`：部署在目标主机，只暴露本机 API，不挂前端控制面板，使用 `AGENT_TOKEN` 给 manager 校验和代理访问。

这意味着后续接更多服务器时，不需要在目标主机上再跑完整控制面板，只需要部署 `agent-only`。

## 当前能力

- 本机资源采集：CPU、内存、磁盘、负载、网络、磁盘 I/O、Docker
- 历史持久化：资源样本写入 SQLite，支持时间范围查看
- 本机文件交互：浏览、上传、下载、删除、重命名、建目录
- 本机运行时查看：Docker 状态、systemd 日志
- 本机接入配置：监听、域名、HTTPS、运行参数
- 节点目录：保存远程节点 URL、WireGuard IP、`AGENT_TOKEN`
- 远程切换查看：manager 通过节点目录代理到远端 agent

## 认证模型

### 浏览器登录

- 只在 `manager` 角色启用
- 首次访问注册一个本地管理员账号
- 之后使用账号密码登录
- 服务端签发 `HttpOnly` 会话 Cookie

### Agent Token

- `AGENT_TOKEN` 不再作为浏览器登录密码
- 它只用于 manager 校验远端 agent、远程代理请求和签名下载
- 节点目录里保存的远端节点 Token 就是这个值

## 安装

### 管理机

```bash
sudo bash scripts/install_manager.sh
```

管理机会安装：

- Python 运行环境
- `sqlite3`
- `wireguard-tools`
- `nginx` / `certbot`
- `filepanel` 服务用户
- 全局命令 `file-panel`
- `manager` systemd 入口

### 目标主机 agent-only

```bash
sudo bash scripts/install_agent_only.sh
```

目标主机会安装：

- Python 运行环境
- `sqlite3`
- `wireguard-tools`
- `filepanel` 服务用户
- 全局命令 `file-panel`
- `agent-only` systemd 入口

不会安装浏览器控制面板入口，也不会启用本地账号密码登录页。

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

`file-panel quick`、`file-panel redeploy`、`file-panel full-install` 会根据当前机器保存的 `FILE_PANEL_ROLE` 自动选择 manager 或 agent-only 安装链。

## 接入更多服务器

如果你要把另一台服务器接入当前 manager：

1. 在目标主机部署 `agent-only`
2. 记录该主机的 `AGENT_TOKEN`
3. 配好 WireGuard，拿到目标主机的 `wg0` 地址
4. 在 manager 的“节点”页录入：
   - 节点名称
   - WireGuard IP
   - 可选 URL
   - `AGENT_TOKEN`

如果填写了 WireGuard IP，但不填 URL，manager 默认会按 `http://<wireguard-ip>:3000` 访问远端 agent。

## WireGuard

项目当前只负责安装 `wireguard-tools`，不会自动创建 peer、密钥或 `wg0` 隧道。

推荐用法：

- 管理机部署 `manager`
- 每台目标主机部署 `agent-only`
- manager 和 agent 通过 WireGuard 私网互通
- 节点目录优先使用 `WireGuard IP + AGENT_TOKEN`

具体示例见 [WIREGUARD.md](WIREGUARD.md)。

## 开发启动

### manager

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
FILE_PANEL_ROLE=manager \
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
python -m app.manager_main
```

### agent-only

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
FILE_PANEL_ROLE=agent \
HOST=0.0.0.0 \
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
python -m app.agent_main
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [WIREGUARD.md](WIREGUARD.md)
- [AGENT_ONBOARDING.md](AGENT_ONBOARDING.md)
- [WIREGUARD_BOOTSTRAP.md](WIREGUARD_BOOTSTRAP.md)
- [USAGE.md](USAGE.md)
- [DEVELOPMENT.md](DEVELOPMENT.md)
- [API.md](API.md)
- [CONCEPTS.md](CONCEPTS.md)

## Recommended Onboarding Flow

The recommended flow is now:

1. Keep the manager host as `manager` only.
2. Install `agent-only` on the target host.
3. Run the interactive wizard on the target host:

```bash
sudo file-panel setup-agent
```

4. Follow the CLI questions to configure `wg0`.
5. After it prints the target `WireGuard IP` and `AGENT_TOKEN`, go back to the manager UI and add the node manually.

See [AGENT_ONBOARDING.md](AGENT_ONBOARDING.md) for the full step-by-step guide.
The manager `wg0` template is in [wireguard/manager-wg0.example.conf](wireguard/manager-wg0.example.conf).

## Advanced WireGuard Bootstrap Flow

This repository now supports a guided manager -> agent bootstrap flow.

1. Install the manager on the control host and make sure `wg0` is already configured there.
2. Open the manager UI and go to the `Nodes` view.
3. In `WireGuard 引导接入`, enter:
   - manager public URL
   - WireGuard endpoint host or public IP
   - optional node name
   - token expiry
4. Generate the one-time bootstrap command and copy it.
5. On the target host, inside the project directory, run:

```bash
sudo bash scripts/install_agent_only.sh
sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>
```

After the second command succeeds, the agent will:

- generate its own WireGuard keypair
- request an IP from the manager
- write `/etc/wireguard/wg0.conf`
- start `wg-quick@wg0`
- register itself into the manager node directory automatically

The bootstrap token is single-use and expires automatically.
