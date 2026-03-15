# 使用说明

## 首次进入

1. 安装并启动服务。
2. 浏览器访问面板地址。
3. 如果系统还没有本地管理员账号，先完成注册。
4. 注册完成后，浏览器会拿到服务端会话 Cookie。

## 登录

- 登录方式：账号 + 密码
- 会话保存方式：服务端 `HttpOnly` Cookie
- 浏览器不再保存 `AGENT_TOKEN` 作为登录凭据

## 概览页

- 查看当前值卡片
- 查看 `1m / 5m` 平滑值
- 查看资源趋势图
- 查看 Docker、网卡、磁盘分项

## 文件页

- 浏览 `AGENT_ROOT` 范围内的文件
- 上传、下载、重命名、删除、创建目录
- 文件列表在工作区内滚动，不依赖整个页面滚动

## 接入页

- 查看当前监听和目标监听
- 接入域名并启用 HTTPS
- 修改运行配置
- 修改 `AGENT_ROOT`
- 重置 `AGENT_TOKEN`

## 节点页

- 新增远程节点
- 保存远程节点 URL
- 保存 WireGuard 地址
- 保存远程节点 Token

当前节点页主要用于登记节点信息，不代表已经具备远程代理执行能力。

## 日志页

- 查看当前节点的 systemd 日志
- 按 `Info / Warning / Error` 切换级别
- 切换页面时会优先复用预热数据

## 文档页

文档页用于快速说明：

- 项目定位
- 登录与认证模型
- 资源指标概念
- 文件边界
- 节点目录用途

## 常用控制命令

```bash
file-panel start
file-panel restart
file-panel stop
file-panel status
file-panel logs 120
file-panel info
file-panel uninstall
```
