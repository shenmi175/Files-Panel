# API And Auth

## 认证

### 浏览器会话

- 只在 `manager` 启用
- 首次注册本地管理员账号
- 登录成功后由服务端写入会话 Cookie

相关接口：

- `GET /api/auth/session`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### `AGENT_TOKEN`

- 不再用于浏览器登录
- 用于 manager 访问远端 `agent-only`
- 用于部分 Bearer 校验和文件下载场景

## 接口分组

### 系统

- `GET /api/health`
- `GET /api/agent`

### 接入与配置

- `GET /api/access`
- `POST /api/access/domain`
- `GET /api/config`
- `POST /api/config`
- `POST /api/config/reset-token`

### 资源

- `GET /api/resources`
- `GET /api/resources/history?range=15m|1h|6h|24h|7d`

### 文件

- `GET /api/files`
- `POST /api/files/mkdir`
- `POST /api/files/rename`
- `POST /api/files/upload`
- `DELETE /api/files`
- `GET /api/files/download-link`
- `GET /api/files/download`

### 运行时

- `GET /api/runtime/docker`
- `GET /api/runtime/logs`

### 节点

- `GET /api/servers`
- `POST /api/servers`
- `PUT /api/servers/{id}`
- `DELETE /api/servers/{id}`

### 更新

- `GET /api/update/status`
- `POST /api/update`
- `POST /api/update/all-nodes`

### WireGuard 引导

- `GET /api/bootstrap/wireguard/status`
- `POST /api/bootstrap/wireguard/prepare`
- `POST /api/bootstrap/wireguard/register`

## 远端代理说明

manager 通过节点目录代理远端请求。
浏览器仍然只访问 manager，本机 API 会带上 `server_id` 再由 manager 转发到远端 agent。

常见远端代理接口：

- `/api/agent`
- `/api/access`
- `/api/resources`
- `/api/resources/history`
- `/api/runtime/docker`
- `/api/runtime/logs`
- `/api/files/*`

## 边界

- 文件操作受 `AGENT_ROOT` 限制
- 远端节点可达性问题通常表现为 `failed to reach remote server ...`
- token 错误通常会返回 `401/403`，而不是 `Connection refused`
