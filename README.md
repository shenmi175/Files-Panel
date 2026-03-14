# File Panel

一个面向 Ubuntu/Linux 节点的 Python/FastAPI 控制面板，用于查看当前节点资源、浏览文件、读取运行日志，并维护后续多服务器集中管理所需的节点目录配置。

## 当前能力

- 查看当前节点资源概览
  - uptime
  - load average
  - CPU、内存、磁盘、网络、进程
  - Docker 运行状态
- 浏览文件目录
- 上传、下载、删除、重命名文件
- 新建目录
- 查看当前访问状态
  - 当前监听地址
  - 域名接入状态
  - nginx / certbot 状态
- 在面板内接入域名
  - 输入域名
  - 自动写入 nginx 配置
  - 自动 reload nginx
  - 自动通过 certbot 申请 HTTPS 证书
  - 接入完成后把服务切回 `127.0.0.1`
- Bearer Token 鉴权
  - Token 通过 SQLite 和环境变量初始化
  - 前端只保存到当前浏览器会话
- 节点目录管理
  - 自动维护本机节点记录
  - 支持录入远程节点 URL
  - 支持预留 WireGuard 管理地址

## 技术栈

- 后端：Python + FastAPI + Uvicorn
- 资源采集：`psutil`
- 配置持久化：`sqlite3`
- 前端：静态 HTML/CSS/JS
- 反代与证书：`nginx + certbot`
- 部署：`systemd`

## 快速安装

前提：

- Python 3.12+
- Ubuntu/Linux
- 如果需要域名接入，目标域名的 `A/AAAA` 记录需要指向当前服务器
- 80/443 端口可对外开放，供 nginx 和 certbot 使用

安装：

```bash
sudo bash scripts/install_agent.sh
```

安装完成后会自动：

- 安装 Python 运行环境、`nginx`、`certbot`、`sqlite3`
- 创建 `/opt/files-agent`
- 创建 Python 虚拟环境并安装依赖
- 安装 `systemd` 服务
- 安装全局命令 `/usr/local/bin/file-panel`
- 初始化 SQLite 存储目录 `/var/lib/files-agent/file-panel.db`
- 首次自动生成 `AGENT_TOKEN`

## 全局命令

安装完成后可直接使用：

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel uninstall
```

说明：

- `file-panel start`：启动服务
- `file-panel restart`：重启服务
- `file-panel uninstall`：一键卸载应用目录、环境文件、SQLite 数据和全局命令
- `file-panel logs 120`：查看最近 120 行日志

频繁迭代代码时，也可以继续使用：

```bash
bash scripts/agentctl.sh quick
bash scripts/agentctl.sh redeploy
bash scripts/agentctl.sh full-install
```

## 首次访问流程

```text
1. 打开 http://服务器IP:3000
2. 输入安装脚本打印出的 AGENT_TOKEN
3. 在面板中查看当前节点资源或修改运行配置
4. 如果需要公网入口，在配置页接入域名
5. 域名接入完成后，改用 https://你的域名 访问
```

## 手动开发启动

如果只是本地开发测试，也可以手动启动：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
AGENT_TOKEN="$(.venv/bin/python scripts/generate_token.py)" \
HOST=0.0.0.0 \
PORT=3000 \
AGENT_ROOT=/ \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
ALLOW_SELF_RESTART=0 \
.venv/bin/python -m app
```

## 配置来源

当前版本使用 SQLite 持久化保存运行配置，默认数据库路径：

```text
/var/lib/files-agent/file-panel.db
```

环境文件 `/etc/files-agent/files-agent.env` 主要用于提供启动期基础路径：

- `ENV_FILE_PATH`
- `STATE_DIR`
- `DATABASE_PATH`
- `AGENT_SERVICE_NAME`
- `NGINX_SERVICE_NAME`

SQLite 中持久化保存的核心运行配置包括：

- `HOST`
- `PORT`
- `AGENT_NAME`
- `AGENT_ROOT`
- `AGENT_TOKEN`
- `RESOURCE_SAMPLE_INTERVAL`
- `CERTBOT_EMAIL`
- `ALLOW_SELF_RESTART`

## 多服务器预留

当前运行时仍以“当前节点”操作为主，但已经预留了多服务器所需的基础配置空间：

- `servers` 表用于保存节点目录
- 支持记录远程节点 URL
- 支持记录 WireGuard 管理地址
- 前端设置页可维护节点目录

后续如果扩展集中管理，建议在当前项目外再增加一个 manager 层，统一代理多个 agent，而不是把本项目改成 SSH 面板。

## API

- `GET /api/health`
- `GET /api/agent`
- `GET /api/access`
- `GET /api/config`
- `POST /api/config`
- `POST /api/access/domain`
- `GET /api/resources`
- `GET /api/resources/history`
- `GET /api/runtime/docker`
- `GET /api/runtime/logs`
- `GET /api/files?path=/`
- `POST /api/files/mkdir`
- `DELETE /api/files?path=/tmp/a.txt`
- `POST /api/files/rename`
- `POST /api/files/upload?path=/tmp`
- `GET /api/files/download?path=/tmp/a.txt`
- `GET /api/servers`
- `POST /api/servers`
- `PUT /api/servers/{id}`
- `DELETE /api/servers/{id}`

## 卸载

一键卸载：

```bash
sudo file-panel uninstall
```

会删除：

- `/opt/files-agent`
- `/etc/files-agent`
- `/var/lib/files-agent`
- `/usr/local/bin/file-panel`
- `files-agent` 对应的 `systemd` unit
- 项目生成的 `files-agent-*.conf` nginx 站点配置

不会自动卸载：

- `nginx`
- `certbot`
- `sqlite3`

## 目录结构

```text
.
├── app/
├── scripts/
├── static/
├── systemd/
├── requirements.txt
└── README.md
```
