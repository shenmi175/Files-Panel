# File Panel

`File Panel` 是一个部署在 Ubuntu/Linux 目标机器上的单机 agent 面板。

当前版本由同一个 FastAPI 服务同时提供：

- 本机资源概览与历史趋势
- 本机文件工作区
- 本机 Docker / systemd 日志查看
- 本机接入配置
- 远程节点目录登记

## 当前架构

- 前端静态资源位于 `static/`
- 后端 API 位于 `app/`
- 浏览器登录使用本地管理员账号密码
- `AGENT_TOKEN` 不再用于浏览器登录，只用于节点验证、外部校验和签名下载

这意味着当前项目仍然是“每台机器一个 agent”的模式，而不是已经完成的多节点 manager。

## 核心能力

- 资源采集：CPU、内存、磁盘、负载、网络、磁盘 I/O、Docker 概览
- 历史趋势：样本写入 SQLite，支持 `15m / 1h / 6h / 24h / 7d`
- 文件操作：浏览、上传、下载、删除、重命名、建目录
- 接入配置：监听、域名、HTTPS、运行配置
- 节点目录：保存远程节点 URL、WireGuard 地址、节点 Token
- 日志查看：systemd 运行日志分级过滤

## 认证模型

### 浏览器登录

- 首次访问时注册一个本地管理员账号
- 之后使用账号密码登录
- 服务端签发 `HttpOnly` 会话 Cookie

### Agent Token

- `AGENT_TOKEN` 不是浏览器密码
- 它用于节点接入、外部 API 校验和文件下载签名
- 节点目录中录入的远程节点 Token 也是这个用途

## 安装

```bash
sudo bash scripts/install_agent.sh
```

安装脚本会完成：

- Python 运行环境准备
- `sqlite3` 安装
- `wireguard-tools` 安装
- `filepanel` 服务用户创建
- SQLite 状态目录初始化
- `file-panel` 控制命令安装

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

## 开发启动

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
python -m app
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [USAGE.md](USAGE.md)
- [DEVELOPMENT.md](DEVELOPMENT.md)
- [API.md](API.md)
- [CONCEPTS.md](CONCEPTS.md)

## 现阶段边界

- 资源采集和文件交互都是本机真实能力，不是占位
- 节点目录目前主要是登记簿，尚未完成真正的远程代理执行
- WireGuard 当前只负责安装和地址预留，不负责自动组网编排
