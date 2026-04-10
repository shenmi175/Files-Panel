# Development

## 本地运行

### manager

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
FILE_PANEL_ROLE=manager \
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
python -m app.manager_main
```

### agent-only

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
FILE_PANEL_ROLE=agent \
HOST=0.0.0.0 \
AGENT_ROOT=/srv/file-panel/data \
STATE_DIR=/var/lib/files-agent \
DATABASE_PATH=/var/lib/files-agent/file-panel.db \
python -m app.agent_main
```

## 主要模块

### 后端

- `app/core/settings.py`：运行配置加载
- `app/core/storage.py`：SQLite 初始化与读写
- `app/core/auth.py`：会话和 token 鉴权
- `app/services/resources.py`：资源采样与历史
- `app/services/files.py`：文件边界与文件操作
- `app/services/remote_nodes.py`：manager 远端代理
- `app/services/updates.py`：更新状态与调度
- `app/services/wireguard_bootstrap.py`：WireGuard 引导注册

### 前端

- `static/index.html`：页面骨架
- `static/js/app.js`：启动、切页、预热
- `static/js/shared.js`：共享状态和通用工具
- `static/js/resources.js`：概览页
- `static/js/files.js`：文件页
- `static/js/settings.js`：接入、配置、节点、更新
- `static/js/logs.js`：日志页

## 资源历史设计

- 样本持久化到 SQLite 的 `resource_samples`
- 前端按时间范围读取
- 长时间范围查询时由后端降采样

## 文档维护约定

- `README.md` 只保留入口和导航
- `wiki/` 保存详细正文
- GitHub Wiki 由 `.github/workflows/publish-github-wiki.yml` 从 `wiki/` 自动同步
- 第一次启用时，需要先在 GitHub 上开启 Wiki 并创建一个初始页面
- 如果默认 `GITHUB_TOKEN` 无法推送 wiki，可配置 `GH_WIKI_TOKEN`
- 本地预览导出结果可执行：
  `python3 scripts/export_github_wiki.py --repo-root . --source-dir wiki --output-dir /tmp/github-wiki-preview --repository <owner/repo> --ref <branch>`
- 涉及安装、接入、更新、WireGuard 的改动时，要同步检查：
  - `wiki/Install-and-Roles.md`
  - `wiki/Node-Onboarding-and-WireGuard.md`
