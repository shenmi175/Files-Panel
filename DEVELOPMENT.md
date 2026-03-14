# 开发文档

## 运行开发环境

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
python -m app
```

常见环境变量：

- `HOST`
- `PORT`
- `AGENT_NAME`
- `AGENT_ROOT`
- `STATE_DIR`
- `DATABASE_PATH`
- `AGENT_TOKEN`
- `RESOURCE_SAMPLE_INTERVAL`
- `ALLOW_SELF_RESTART`

## 后端模块

### `app/core`

- `settings.py`：初始化运行配置
- `storage.py`：SQLite 表和读写函数
- `auth.py`：鉴权和会话

### `app/routes`

- `system.py`：健康检查和 agent 信息
- `auth.py`：登录、登出、会话状态
- `resources.py`：资源快照和历史趋势
- `files.py`：文件工作区
- `access.py`：接入与运行配置
- `runtime.py`：Docker 和日志
- `servers.py`：节点目录

### `app/services`

- `resources.py`：采样、平滑、历史持久化
- `files.py`：路径边界和文件操作
- `access.py`：配置写入、域名接入、helper 调用
- `runtime.py`：Docker 和日志
- `servers.py`：节点登记

## 前端模块

- `static/index.html`：视图结构
- `static/js/app.js`：入口、切页、预热
- `static/js/shared.js`：共享状态与基础工具
- `static/js/resources.js`：资源概览
- `static/js/files.js`：文件工作区
- `static/js/settings.js`：接入、配置、节点
- `static/js/logs.js`：日志

## 资源历史设计

资源样本持久化到 SQLite 的 `resource_samples` 表，前端按时间范围查询。

当前设计原则：

- 当前值显示最近一次采样
- `1m / 5m` 显示滑动窗口结果
- 趋势图显示持久化历史
- 长时间范围查询时后端做降采样

## 多节点扩展建议

如果后续要真正支持统一管理多节点，建议新增一个 manager 层，而不是直接在当前 agent 上叠加远程执行逻辑。

优先抽象：

- `resources provider`
- `files provider`
- `runtime provider`
- `access provider`

然后让本机 provider 和远程 provider 走统一接口。
