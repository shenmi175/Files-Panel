# API 文档

## 认证模型

### 1. 健康检查

- `GET /api/health`

返回服务状态和是否启用鉴权。

### 2. 登录会话

- `GET /api/auth/session`
- `POST /api/auth/login`
- `POST /api/auth/logout`

浏览器登录后使用服务端会话 Cookie 访问 API。

## 系统与接入

- `GET /api/agent`
- `GET /api/access`
- `POST /api/access/domain`
- `GET /api/config`
- `POST /api/config`
- `POST /api/config/reset-token`

## 资源

- `GET /api/resources`
- `GET /api/resources/history?range=15m|1h|6h|24h|7d`

### 历史接口语义

- `interval_seconds`：原始采样周期
- `resolution_seconds`：当前图表分辨率
- `range_key`：当前查询范围
- `points`：趋势点
- `summary`：当前值和 `1m / 5m`

## 文件

- `GET /api/files?path=/`
- `POST /api/files/mkdir`
- `POST /api/files/rename`
- `POST /api/files/upload?path=/target`
- `DELETE /api/files?path=/target`
- `POST /api/files/download-link`
- `GET /api/files/download`

## 运行时

- `GET /api/runtime/docker`
- `GET /api/runtime/logs`

## 节点目录

- `GET /api/servers`
- `POST /api/servers`
- `PUT /api/servers/{id}`
- `DELETE /api/servers/{id}`

## 说明

当前 `servers` 相关接口只负责节点登记，不会直接代理远程执行资源、文件或日志操作。
