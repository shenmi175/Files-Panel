# File Panel

`File Panel` 提供两种运行角色：

- `manager`：管理机入口，提供浏览器面板、管理员登录、节点目录和远端代理
- `agent-only`：目标主机入口，只暴露本机 API，供 manager 通过 `AGENT_TOKEN` 代理访问

## 快速开始

### 管理机

```bash
sudo bash scripts/install_manager.sh
```

### 目标主机

```bash
sudo bash scripts/install_agent_only.sh
```

`agent-only` 只安装 agent 和 `wireguard-tools`，不会自动创建 `wg0`。
安装后继续按 [Node Onboarding And WireGuard](wiki/Node-Onboarding-and-WireGuard.md) 完成接入。

## 常用命令

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel quick
file-panel redeploy
file-panel full-install
file-panel uninstall
```

## 文档入口

仓库内详细说明已经收敛到 `wiki/` 目录。

### 运维

- [Wiki Home](wiki/Home.md)
- [Install And Roles](wiki/Install-and-Roles.md)
- [Operations](wiki/Operations.md)
- [Node Onboarding And WireGuard](wiki/Node-Onboarding-and-WireGuard.md)

### 开发

- [Architecture](wiki/Architecture.md)
- [API And Auth](wiki/API-and-Auth.md)
- [Development](wiki/Development.md)

## GitHub Wiki 同步

- `wiki/` 是文档源目录
- `.github/workflows/publish-github-wiki.yml` 会在默认分支 push 时，把 `wiki/` 发布到 GitHub Wiki
- 第一次使用前，需要先在 GitHub 仓库设置里启用 Wiki，并手动创建一个初始页面
- 如果仓库权限策略不允许工作流直接推送 wiki，可额外配置 `GH_WIKI_TOKEN` secret

## 仓库结构

```text
app/         FastAPI 入口、路由、服务层、SQLite 存储
static/      前端页面与浏览器端脚本
scripts/     安装、更新、WireGuard 与辅助命令
systemd/     manager / agent-only systemd 单元
wireguard/   manager wg0 配置模板
wiki/        仓库内 wiki 正文
```
