# 使用文档

## 安装

```bash
sudo bash scripts/install_agent.sh
```

安装脚本会：

- 安装 Python 依赖
- 安装 `sqlite3`
- 安装 `wireguard-tools`
- 创建 `filepanel` 服务用户
- 初始化状态目录和数据库
- 写入 systemd 服务
- 注册 `file-panel` 命令

## 登录

首次安装后可通过：

```bash
file-panel info
```

查看访问入口和访问令牌。

浏览器登录成功后，服务端会写入 HttpOnly 会话 Cookie，后续前端通过该会话调用 API。

## 页面说明

### 概览

- 查看 CPU、内存、磁盘、负载
- 查看 `当前 / 1m / 5m`
- 查看趋势图范围和 Docker 状态

### 文件

- 浏览 `AGENT_ROOT` 内的目录
- 上传、下载、重命名、删除、创建目录

### 接入

- 设置域名、HTTPS、监听
- 修改采样间隔、端口、根目录、令牌

### 节点

- 登记远程节点 URL
- 保存远程节点访问令牌
- 保存 WireGuard 地址

### 日志

- 查看 systemd 日志
- 按 `Info / Warning / Error` 切换

### 文档

- 查看项目介绍
- 查看概念解释
- 查看开发和调用边界

## 常用命令

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel uninstall
```

## 根目录边界

`AGENT_ROOT` 决定文件工作区允许访问的根目录。

- 文件页只能看到这个边界内的文件
- 所有文件操作都受这个边界限制
- 不建议把高敏感系统目录直接暴露给文件工作区
