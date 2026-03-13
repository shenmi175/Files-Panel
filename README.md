# Files Panel

一个最小可运行的 Rust 面板框架，用于通过 SSH 连接 Ubuntu 服务器，查看基础资源信息并执行常用文件操作。

## 当前能力

- 录入远程 Ubuntu 主机
- 支持密码登录或 SSH 私钥登录
- SSH 连通性测试
- 通过 SSH 拉取基础资源信息
  - `uptime`
  - `load average`
  - 内存使用
  - 根分区磁盘使用
- 浏览远程目录列表
- 上传文件到当前目录
- 下载文件
- 删除文件或目录
- 重命名文件或目录
- Docker 一键启动

## 技术栈

- 后端：Rust + Axum + Tokio
- 远程连接：系统 `ssh` + `scp` + `sshpass`
- 前端：静态 HTML/CSS/JS
- 部署：Docker Compose

## 快速启动

前提：

- 本机安装 Docker 和 Docker Compose
- 如果使用私钥模式，面板宿主机需要能访问 SSH 私钥，例如 `~/.ssh/id_rsa`
- 如果使用密码模式，不需要挂载私钥

启动：

```bash
docker compose up --build
```

访问：

```text
http://localhost:3000
```

私钥模式下，`private_key_path` 填容器内路径，例如：

```text
/root/.ssh/id_rsa
```

## API

- `GET /api/health`
- `GET /api/servers`
- `POST /api/servers`
- `POST /api/servers/:id/probe`
- `POST /api/servers/:id/test`
- `GET /api/servers/:id/resources`
- `GET /api/servers/:id/files?path=/`
- `DELETE /api/servers/:id/files?path=/tmp/a.txt`
- `POST /api/servers/:id/files/rename`
- `POST /api/servers/:id/files/upload?path=/tmp`
- `GET /api/servers/:id/files/download?path=/tmp/a.txt`

## 目录

```text
.
├── Cargo.toml
├── Dockerfile
├── docker-compose.yml
├── src/main.rs
└── static/
```

## 已知限制

- 目前只验证 Ubuntu/Linux 路径和命令
- 没有用户系统和权限隔离，密码当前会保存在本地 `data/servers.json`
- 当前没有历史监控和告警
