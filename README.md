# Files Agent

一个面向单机部署的 Python/FastAPI agent，用于在目标 Ubuntu/Linux 服务器上直接查看资源信息并执行常用文件操作。

## 设计目标

- 直接部署到目标服务器，不再通过 SSH 中转
- 不落地保存任何服务器密码
- 代码仓库不包含运行期凭据
- 安装后先临时开放 `IP:3000`，域名接入成功后再自动切回仅本地监听
- 通过面板输入域名即可生成 Caddy 反代和 HTTPS 证书配置

## 当前能力

- 查看本机基础资源信息
  - `uptime`
  - `load average`
  - 内存使用
  - agent 根目录磁盘使用
- 浏览目录列表
- 上传文件到当前目录
- 下载文件
- 删除文件或目录
- 重命名文件或目录
- 新建目录
- 查看当前访问状态
  - 当前监听地址
  - 域名状态
  - Caddy 状态
- 面板内接入域名
  - 输入域名
  - 自动写入 Caddy 配置
  - 自动 reload Caddy
  - 配置完成后把 agent 切回 `127.0.0.1`
- 可选 Bearer Token 鉴权
  - Token 通过环境变量注入
  - 前端只保存到当前浏览器会话，不落地到服务器数据文件

## 技术栈

- 后端：Python + FastAPI + Uvicorn
- 资源采集：`psutil`
- 前端：静态 HTML/CSS/JS
- 部署：`systemd`

## 快速启动

推荐方式是直接在目标服务器执行安装脚本。

前提：

- Python 3.12+
- Ubuntu/Linux
- 目标域名的 `A/AAAA` 记录可以指向当前服务器
- 80/443 可以对外放行，供 Caddy 申请和续期证书

安装：

```bash
sudo bash scripts/install_agent.sh
```

安装脚本会自动完成下面这些事：

- 安装 Python 运行环境和 Caddy
- 创建 `/opt/files-agent`
- 创建 Python 虚拟环境并安装依赖
- 安装 `systemd` 服务
- 首次自动生成并保存 `AGENT_TOKEN`
- 初始写入 `HOST=0.0.0.0`，便于你先通过 `IP:3000` 临时访问

安装完成后，脚本会直接打印两项信息：

- 临时访问地址
- `AGENT_TOKEN`

第一次登录流程：

```text
1. 打开 http://服务器IP:3000
2. 输入安装脚本打印出的 AGENT_TOKEN
3. 在面板中填入域名
4. 等待 Caddy 配置完成
5. 后续改用 https://你的域名 访问
```

域名接入成功后，agent 会把监听地址自动切回 `127.0.0.1:3000`，外部不再直接暴露 3000 端口。

## 手动开发启动

如果你只是在本地开发测试，也可以手动启动：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
AGENT_TOKEN="$(.venv/bin/python scripts/generate_token.py)" \
HOST=0.0.0.0 \
PORT=3000 \
AGENT_ROOT=/ \
ALLOW_SELF_RESTART=0 \
.venv/bin/python -m app
```

## 环境变量

- `HOST`
  - 应用默认是 `127.0.0.1`
  - 安装脚本首次部署会写成 `0.0.0.0`
  - 域名接入完成后会自动改成 `127.0.0.1`
- `PORT`
  - 默认 `3000`
- `AGENT_NAME`
  - 默认当前主机名
- `AGENT_ROOT`
  - 默认 `/`
  - 所有文件操作都限制在该目录内
- `AGENT_TOKEN`
  - 可选
  - 设置后，除 `/api/health` 和 `/api/agent` 外，其余接口都需要 `Authorization: Bearer <token>`
- `ENV_FILE_PATH`
  - 默认 `/etc/files-agent/files-agent.env`
- `STATE_DIR`
  - 默认 `/var/lib/files-agent`
- `CADDYFILE_PATH`
  - 默认 `/etc/caddy/Caddyfile`
- `AGENT_SERVICE_NAME`
  - 默认 `files-agent`
- `CADDY_SERVICE_NAME`
  - 默认 `caddy`
- `ALLOW_SELF_RESTART`
  - 默认 `1`
  - 域名接入后是否自动重启 agent 以切回本地监听

仓库里提供了 `.env.example` 作为占位示例，但不要把真实 token 写进仓库。

## API

- `GET /api/health`
- `GET /api/agent`
- `GET /api/access`
- `POST /api/access/domain`
- `GET /api/resources`
- `GET /api/files?path=/`
- `POST /api/files/mkdir`
- `DELETE /api/files?path=/tmp/a.txt`
- `POST /api/files/rename`
- `POST /api/files/upload?path=/tmp`
- `GET /api/files/download?path=/tmp/a.txt`

## systemd 部署

仓库内提供了 `systemd/files-agent.service` 模板和 `scripts/install_agent.sh` 安装脚本，默认部署路径如下：

- 应用目录：`/opt/files-agent`
- 环境文件：`/etc/files-agent/files-agent.env`
- systemd unit：`/etc/systemd/system/files-agent.service`
- Caddy 配置：`/etc/caddy/Caddyfile`

安装脚本生成的环境文件会包含：

```bash
HOST=0.0.0.0
PORT=3000
AGENT_NAME=prod-01
AGENT_ROOT=/
AGENT_TOKEN=<自动生成>
ENV_FILE_PATH=/etc/files-agent/files-agent.env
STATE_DIR=/var/lib/files-agent
CADDYFILE_PATH=/etc/caddy/Caddyfile
AGENT_SERVICE_NAME=files-agent
CADDY_SERVICE_NAME=caddy
ALLOW_SELF_RESTART=1
```

之后域名接入页面会自动把 `HOST` 改成 `127.0.0.1`，并写入 `PUBLIC_DOMAIN=<你的域名>`。

## 安全边界

- 仓库已忽略 `.env`、虚拟环境、日志和 `data/` 运行目录
- 旧的示例密码文件已经移除
- 当前版本不做用户系统，生产环境建议保持下面这套方式：
  - 安装脚本自动生成 `AGENT_TOKEN`
  - 临时只在初始化阶段开放 `IP:3000`
  - 域名接入成功后自动切回仅本地监听
  - 通过 Caddy 统一暴露 HTTPS 域名入口

## 目录

```text
.
├── app/
├── scripts/
├── static/
├── systemd/
├── requirements.txt
└── README.md
```
