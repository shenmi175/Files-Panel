# Architecture

## 运行角色

### manager

- 入口：`app.manager_main`
- 提供静态前端
- 提供管理员登录
- 保存节点目录
- 代理远端 `agent-only`

### agent-only

- 入口：`app.agent_main`
- 不挂载静态前端
- 不提供浏览器登录
- 只暴露本机 API

## 后端结构

```text
app/
  agent_main.py
  manager_main.py
  core/
    auth.py
    settings.py
    storage.py
  routes/
    auth.py
    bootstrap.py
    access.py
    resources.py
    runtime.py
    files.py
    servers.py
    system.py
    updates.py
  services/
    access.py
    files.py
    remote_nodes.py
    resources.py
    runtime.py
    servers.py
    updates.py
    wireguard_bootstrap.py
```

## 请求流

### 本机视角

- 浏览器只访问 manager
- manager 前端只调用 manager 本机 API
- manager 本机 API 再决定走本机服务还是远端代理

### 远端节点视角

- manager 在节点目录里保存：
  - `base_url`
  - `wireguard_ip`
  - `auth_token`
- manager 通过 `app/services/remote_nodes.py` 访问远端 `agent-only`

## 存储

- SQLite：`config`、`access_state`、`servers`、`resource_samples`
- 资源历史持久化到 `resource_samples`
- WireGuard 引导 token 也持久化到 SQLite

## 核心概念

### `AGENT_ROOT`

- 文件工作区的边界
- 上传、删除、重命名、下载都受它限制

### `AGENT_TOKEN`

- 不是浏览器密码
- 用于 manager 访问远端 agent

### 资源历史

- 当前值展示最近一次采样
- `1m / 5m` 展示滑动平滑值
- 趋势图来自 SQLite 历史样本

### 节点目录

- 保存节点元数据
- 保存远端访问地址与 token
- 是 manager 代理层的配置来源

## 部署模型

### manager

- systemd：`systemd/files-agent.service`
- Python 入口：`python -m app.manager_main`

### agent-only

- systemd：`systemd/files-agent-node.service`
- Python 入口：`python -m app.agent_main`

## WireGuard 建议

推荐使用 hub-and-spoke：

- manager：`10.66.0.1`
- agent A：`10.66.0.2`
- agent B：`10.66.0.3`

manager 通过 WireGuard 地址访问 agent：

```text
http://10.66.0.2:3000
http://10.66.0.3:3000
```
