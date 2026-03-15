# API 说明

## 认证相关

### 浏览器会话

- `GET /api/auth/session`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`

说明：

- 首次注册后会创建本地管理员账号
- 登录成功后服务端写入会话 Cookie
- 后续浏览器通过 Cookie 调用受保护 API

### Agent Token

`AGENT_TOKEN` 不再用于浏览器登录。

它当前用于：

- 节点接入凭据
- 外部 Bearer 校验预留
- 文件签名下载链接

## 系统信息

- `GET /api/health`
- `GET /api/agent`

## 接入与运行配置

- `GET /api/access`
- `POST /api/access/domain`
- `GET /api/config`
- `POST /api/config`
- `POST /api/config/reset-token`

## 资源

- `GET /api/resources`
- `GET /api/resources/history?range=15m|1h|6h|24h|7d`

历史接口会返回：

- 当前采样间隔
- 图表实际分辨率
- 当前查看时间范围
- 采样点列表
- `current / 1m / 5m` 汇总

## 文件

- `GET /api/files?path=/target`
- `POST /api/files/mkdir`
- `POST /api/files/rename`
- `POST /api/files/upload?path=/target`
- `DELETE /api/files?path=/target`
- `GET /api/files/download-link`
- `GET /api/files/download`

说明：

- 文件操作限制在 `AGENT_ROOT` 内
- 下载走短时签名链接

## 运行时

- `GET /api/runtime/docker`
- `GET /api/runtime/logs`

## 节点目录

- `GET /api/servers`
- `POST /api/servers`
- `PUT /api/servers/{id}`
- `DELETE /api/servers/{id}`

说明：

- 当前只保存节点元数据
- 尚未完成远程资源/文件/日志代理执行
