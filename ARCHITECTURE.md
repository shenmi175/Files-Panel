# 项目架构

## 角色拆分

现在项目有两个明确入口：

- `app.manager_main`
  - 部署在管理机
  - 挂载静态前端
  - 提供管理员账号密码登录
  - 提供节点目录和远端代理
- `app.agent_main`
  - 部署在目标主机
  - 不挂载静态前端
  - 不提供浏览器登录页
  - 只暴露本机 API，依赖 `AGENT_TOKEN` 给 manager 访问

`app/main.py` 仍然保留为 manager 兼容入口。

## 后端分层

```text
app/
  agent_main.py      agent-only FastAPI 入口
  manager_main.py    manager FastAPI 入口
  core/
    auth.py          会话与 AGENT_TOKEN 鉴权
    settings.py      运行配置与角色加载
    storage.py       SQLite 持久化
  routes/
    auth.py          仅 manager 使用
    servers.py       仅 manager 使用
    access.py        manager 本机 / 远端 agent 代理
    resources.py     manager 本机 / 远端 agent 代理
    runtime.py       manager 本机 / 远端 agent 代理
    files.py         manager 本机 / 远端 agent 代理
    system.py        健康检查与节点信息
  services/
    remote_nodes.py  manager 到远端 agent 的代理客户端
    resources.py     本机资源采样
    files.py         本机文件操作
    runtime.py       本机 Docker 与日志
    access.py        本机监听 / 域名 / 运行配置
```

## 鉴权边界

### manager

- 浏览器请求通过管理员账号密码登录
- 会话保存在 `HttpOnly` Cookie
- manager 前端只和 manager 本机 API 通信

### agent-only

- 不接受浏览器登录
- 不挂载前端静态页
- 远端调用必须携带 `Authorization: Bearer <AGENT_TOKEN>`

## 远端代理模型

manager 在节点目录中保存：

- 节点名称
- `base_url`
- `wireguard_ip`
- `auth_token`

切换节点后，manager 通过 `app/services/remote_nodes.py` 转发这些接口：

- `/api/agent`
- `/api/access`
- `/api/resources`
- `/api/resources/history`
- `/api/runtime/docker`
- `/api/runtime/logs`
- `/api/files/*`

这样浏览器始终只连 manager，一个页面内即可切换不同节点。

## 部署模型

### manager

- systemd 单元：`systemd/files-agent.service`
- Python 入口：`python -m app.manager_main`
- 推荐部署在有固定公网入口或反代入口的管理机上

### agent-only

- systemd 单元模板：`systemd/files-agent-node.service`
- Python 入口：`python -m app.agent_main`
- 推荐只在 WireGuard 私网或受控内网中暴露 `3000`

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

项目当前只负责安装 `wireguard-tools`，不负责编排 WireGuard peer、密钥、路由和隧道生命周期；这些由运维脚本或外部网络管理服务完成。
