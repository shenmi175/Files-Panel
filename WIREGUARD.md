# WireGuard 接入说明

File Panel 当前不会自动创建 WireGuard 网络，只会安装 `wireguard-tools`。如果你要把多台 agent 接入同一个 manager，推荐先把管理平面网络配好，再到 manager 里录入节点。

## 推荐拓扑

用最简单的 hub-and-spoke：

- manager：`10.66.0.1/24`
- agent-01：`10.66.0.2/24`
- agent-02：`10.66.0.3/24`

manager 负责监听 WireGuard，agent 主动连回 manager。

## 生成密钥

每台机器都执行：

```bash
umask 077
wg genkey | tee private.key | wg pubkey > public.key
```

## manager 示例

`/etc/wireguard/wg0.conf`

```ini
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
PrivateKey = <manager-private-key>

[Peer]
PublicKey = <agent-01-public-key>
AllowedIPs = 10.66.0.2/32

[Peer]
PublicKey = <agent-02-public-key>
AllowedIPs = 10.66.0.3/32
```

## agent 示例

`/etc/wireguard/wg0.conf`

```ini
[Interface]
Address = 10.66.0.2/24
PrivateKey = <agent-private-key>

[Peer]
PublicKey = <manager-public-key>
Endpoint = <manager-public-ip>:51820
AllowedIPs = 10.66.0.0/24
PersistentKeepalive = 25
```

## 启动

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show
ip -4 addr show wg0
```

如果 `ip -4 addr show wg0` 没结果，说明 WireGuard 还没有真正跑起来，当前机器也就没有可用的 WireGuard IP。

## 与 File Panel 的关系

### manager

安装：

```bash
sudo bash scripts/install_manager.sh
```

### agent-only

安装：

```bash
sudo bash scripts/install_agent_only.sh
```

安装 agent-only 后，执行：

```bash
sudo file-panel info
```

你需要记录：

- `AGENT_TOKEN`
- `WireGuard IP`
- 如果你不用默认 `3000`，再记录完整 URL

## 录入节点

在 manager 的“节点”页填写：

- 节点名称
- WireGuard IP
- 可选 URL
- `AGENT_TOKEN`

如果填写了 WireGuard IP 但留空 URL，manager 会默认使用：

```text
http://<wireguard-ip>:3000
```

## 建议

- manager 保留浏览器控制面板和管理员账号密码登录
- 目标主机只部署 `agent-only`
- 尽量不要把 agent `3000` 端口直接暴露到公网
- 优先通过 WireGuard 私网访问 agent
