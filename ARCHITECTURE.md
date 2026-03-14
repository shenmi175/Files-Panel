# 项目架构

## 当前定位

File Panel 当前是一个部署在目标 Linux 服务器上的单节点 agent。

- 前端和后端一起由同一个进程提供
- 所有资源采集和文件操作默认都作用于本机
- 当前节点目录只负责登记远程节点，不负责远程代理执行

## 目录结构

```text
app/
  core/        配置、鉴权、SQLite
  routes/      FastAPI 路由
  services/    业务逻辑
static/
  index.html   页面骨架
  js/          前端模块
  styles.css   样式
scripts/
  install_agent.sh
  uninstall_agent.sh
  agentctl.sh
systemd/
  files-agent.service
```

## 运行结构

### 前端

- `static/index.html`：页面和视图容器
- `static/js/app.js`：应用入口、切页、后台预热
- `static/js/resources.js`：资源面板
- `static/js/files.js`：文件工作区
- `static/js/settings.js`：接入、配置、节点
- `static/js/logs.js`：日志面板

### 后端

- `app/main.py`：组装应用与静态资源
- `app/routes/*.py`：API 入口
- `app/services/*.py`：业务实现
- `app/core/storage.py`：SQLite 配置和历史样本
- `app/core/settings.py`：运行配置加载

## 单机边界

当前下列能力都直接依赖本机：

- 资源采样：`psutil`
- 文件管理：本机文件系统
- Docker：本机 `docker.sock`
- 日志：本机 `journalctl`
- 接入：本机 `nginx` / `certbot`

因此现在的服务模型是“每台机器一个 agent”。

## 多节点建议

如果要管理 2-10 台服务器，建议采用：

1. 每台服务器部署一个 agent
2. 通过 WireGuard 打通管理平面网络
3. 再增加一个 manager 层负责统一代理与展示

不要直接把当前 agent 强行改成 SSH 中转面板，这会把本机执行模型和远程执行模型混在一起。
