# 项目架构

## 1. 当前定位

File Panel 当前是一个单节点 agent。

- 前端静态页面和后端 FastAPI API 一起由同一个进程提供
- 部署目标是 Ubuntu/Linux 服务器
- 采集和操作对象默认是本机，不通过 SSH 中转

## 2. 目录结构

```text
app/
  core/        配置、鉴权、SQLite 存储
  routes/      FastAPI 路由
  services/    资源、文件、接入、日志、节点等业务逻辑
static/
  index.html   单页界面骨架
  js/          前端模块
  styles.css   页面样式
scripts/
  install_agent.sh
  uninstall_agent.sh
  agentctl.sh
systemd/
  files-agent.service
```

## 3. 服务分层

### 前端

- `static/index.html`：页面结构
- `static/js/app.js`：应用入口、页面切换、后台预热
- `static/js/resources.js`：资源面板
- `static/js/files.js`：文件工作区
- `static/js/settings.js`：接入、配置、节点
- `static/js/logs.js`：日志页面

### 后端

- `app/main.py`：组装 FastAPI、挂载静态资源
- `app/routes/*.py`：接口入口
- `app/services/*.py`：业务实现
- `app/core/storage.py`：SQLite 持久化
- `app/core/settings.py`：运行配置加载

## 4. 当前单机边界

下列能力当前都直接依赖本机：

- 资源采样：`psutil`
- 文件操作：本机文件系统
- Docker：本机 `docker` socket
- 日志：本机 `journalctl`
- 接入：本机 `nginx` / `certbot`

因此当前项目不是中心化控制台，而是“每台机器一个 agent”。

## 5. 多节点设计建议

如果后续需要 2-10 台机器统一管理，建议采用：

1. 每台服务器继续部署一个 agent
2. 通过 WireGuard 让这些节点互通
3. 再新增一个 manager 层，负责节点目录、代理请求、统一展示

不建议直接把当前 agent 强行改成 SSH 中转面板，因为这会把本机执行模型和远程执行模型混在一起。
