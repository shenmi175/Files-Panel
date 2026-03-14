# File Panel

一个部署在 Ubuntu/Linux 节点上的 Python/FastAPI 控制面板，用于查看当前节点资源、浏览文件、读取运行日志，并为后续 2-10 台节点的 WireGuard 管理网络预留配置。

## 当前能力

- 查看当前节点资源
  - CPU、内存、磁盘、网络、进程、趋势图
  - Docker 运行状态
- 浏览和管理文件
  - 浏览目录
  - 上传、下载、删除、重命名文件
  - 新建目录
- 查看当前访问状态
  - 当前监听地址
  - 域名接入状态
  - nginx / certbot 状态
- 接入域名并自动申请 HTTPS
- Bearer Token 鉴权
- 维护节点目录
  - 自动记录本机节点
  - 预留远程节点 URL
  - 预留 WireGuard 地址

## 安全基线

- `files-agent` 服务默认以专用系统用户 `filepanel` 运行，不再使用 `root`
- 默认 `AGENT_ROOT` 收缩到 `/srv/file-panel/data`
- 只有少量必须的高权限操作通过 root helper 执行
  - nginx 配置写入
  - nginx 校验 / reload
  - certbot 申请证书
  - agent 自重启
- SQLite 状态目录默认位于 `/var/lib/files-agent`

注意：

- 如果你把 `AGENT_ROOT` 改成其他目录，该目录必须对 `filepanel` 用户可读写执行
- Docker 状态读取在某些系统上可能因为 Docker socket 权限而显示不可用，这是非 root 运行的预期安全取舍

## 技术栈

- 后端：Python + FastAPI + Uvicorn
- 资源采集：`psutil`
- 配置持久化：`sqlite3`
- 前端：静态 HTML/CSS/JS
- 反代与证书：`nginx + certbot`
- 节点互联准备：`wireguard-tools`
- 部署：`systemd`

## 快速安装

前提：

- Ubuntu/Linux
- Python 3.12+
- 如果需要接入域名，域名 `A/AAAA` 记录应指向当前服务器
- 80/443 端口可对外开放，供 nginx 和 certbot 使用

安装：

```bash
sudo bash scripts/install_agent.sh
```

安装脚本会自动：

- 安装 `sudo`、Python 运行环境、`nginx`、`certbot`、`sqlite3`、`wireguard-tools`
- 创建专用系统用户 `filepanel`
- 创建应用目录 `/opt/files-agent`
- 创建状态目录 `/var/lib/files-agent`
- 创建默认文件根目录 `/srv/file-panel/data`
- 创建 Python 虚拟环境并安装依赖
- 安装 systemd 服务
- 安装全局命令 `/usr/local/bin/file-panel`
- 安装 root helper `/usr/local/libexec/file-panel/file-panel-helper.sh`
- 写入 sudoers 规则，仅允许 `filepanel` 调用该 helper
- 首次自动生成 `AGENT_TOKEN`

## 全局命令

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel uninstall
```

## 首次访问

```text
1. 打开 http://服务器IP:3000
2. 输入安装脚本打印出的 AGENT_TOKEN
3. 查看资源或调整运行配置
4. 如果需要公网入口，在配置页接入域名
5. 域名接入完成后，改用 https://你的域名 访问
```

接入域名成功后，agent 会切回 `127.0.0.1:3000`，公网访问走 nginx 反代。

## 手动开发启动

本地开发时建议显式指定 `AGENT_ROOT`，不要依赖默认值：

```bash
mkdir -p /srv/file-panel/data
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
AGENT_TOKEN="$(.venv/bin/python scripts/generate_token.py)" \
HOST=0.0.0.0 \
PORT=3000 \
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
ALLOW_SELF_RESTART=0 \
.venv/bin/python -m app
```

## 配置来源

SQLite 默认数据库路径：

```text
/var/lib/files-agent/file-panel.db
```

环境文件 `/etc/files-agent/files-agent.env` 主要提供启动期路径和服务名：

- `ENV_FILE_PATH`
- `STATE_DIR`
- `DATABASE_PATH`
- `AGENT_SERVICE_NAME`
- `NGINX_SERVICE_NAME`
- `PRIVILEGED_HELPER_PATH`

SQLite 中持久化保存的主要运行配置包括：

- `HOST`
- `PORT`
- `AGENT_NAME`
- `AGENT_ROOT`
- `AGENT_TOKEN`
- `RESOURCE_SAMPLE_INTERVAL`
- `CERTBOT_EMAIL`
- `ALLOW_SELF_RESTART`

## WireGuard

当前版本会安装 `wireguard-tools`，但不会自动创建 peer、密钥和隧道。

也就是说，目前项目对 WireGuard 的实际支持是：

- 安装好 `wg` / `wg-quick` 命令
- 在节点目录中记录 `wireguard_ip`
- 为后续多节点接入留出地址字段

当前项目还没有实现：

- 自动生成 WireGuard 配置
- 自动交换公私钥
- 自动创建 peer
- 自动检测隧道健康
- 通过 WireGuard 代理远程节点 API

如果后续要管理 2-10 台机器，推荐做法是：

1. 先用 WireGuard 把这些机器连成管理网络
2. 每台机器单独部署一个 File Panel agent
3. 后续再增加一个 manager 层，统一代理这些 agent

## 多服务器预留

当前运行时仍以“当前节点”操作为主，多服务器只是预留了节点目录和元数据：

- `servers` 表保存节点名称、URL、令牌、WireGuard 地址
- 前端可以维护节点目录
- 当前资源 / 文件 / 日志 / 域名接入仍然只作用于本机

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

```bash
sudo file-panel uninstall
```

会删除：

- `/opt/files-agent`
- `/etc/files-agent`
- `/var/lib/files-agent`
- `/srv/file-panel`
- `/usr/local/bin/file-panel`
- `/usr/local/libexec/file-panel`
- `/etc/sudoers.d/file-panel`
- `filepanel` 系统用户和组
- 项目生成的 `files-agent-*.conf` nginx 站点配置

不会自动卸载：

- `nginx`
- `certbot`
- `sqlite3`
- `wireguard-tools`

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
