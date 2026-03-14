# File Panel

一个部署在 Ubuntu/Linux 服务器上的单节点控制面板，用于管理本机资源、文件、接入和运行日志。

当前项目定位是 `agent`，不是集中式多机管理平台。后续如果要管理 2-10 台服务器，推荐保持“每台机器一个 agent”，再额外增加 manager / proxy 层。

## 功能范围

- 本机资源采集：CPU、内存、磁盘、负载、网络、磁盘 I/O、Docker、趋势图
- 本机文件管理：浏览、上传、下载、重命名、删除、创建目录
- 本机接入管理：监听、域名、HTTPS、令牌、运行配置
- 本机运行日志：systemd 日志查看和级别筛选
- 节点目录：登记远程节点 URL、令牌和 WireGuard 地址

## 快速开始

安装：

```bash
sudo bash scripts/install_agent.sh
```

常用命令：

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel uninstall
```

开发模式：

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
python -m app
```

## 文档目录

- [项目架构](ARCHITECTURE.md)
- [使用文档](USAGE.md)
- [开发文档](DEVELOPMENT.md)
- [API 文档](API.md)
- [概念说明](CONCEPTS.md)

## 当前架构结论

- 前后端是同一个服务一起部署，不是分离部署。
- 当前服务本身就是 agent。
- 如果只想让每台服务器各自有一个面板，直接把 agent 部署到目标机器即可。
- 如果想在一个总面板里统一管理多台机器，还需要额外的 manager 层。
