# WireGuard 接入说明

## 先说结论

- `sudo bash scripts/install_agent_only.sh` 只安装 `agent` 和 `wireguard-tools`
- 这一步不会自动创建 `/etc/wireguard/wg0.conf`
- 手动接入请用 `sudo file-panel setup-agent`
- manager 引导式接入请用 `sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>`

## 推荐拓扑

下面示例使用：

- manager：`10.66.0.1/24`
- agent：`10.66.0.3/24`
- WireGuard 网段：`10.66.0.0/24`
- manager 监听端口：`51820`

## 手动接入步骤

### 1. 先在 manager 上准备 `wg0`

示例 `/etc/wireguard/wg0.conf`：

```ini
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
PrivateKey = <manager-private-key>
```

启动：

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show wg0 public-key
```

如果这里报：

```text
Unable to access interface: No such device
```

说明 manager 的 `wg0` 还没准备好，先不要继续执行 agent 侧步骤。

### 2. 在目标主机安装 agent-only

```bash
sudo bash scripts/install_agent_only.sh
```

### 3. 在目标主机执行向导

```bash
sudo file-panel setup-agent
```

按下面方式填写：

- `manager 的 WireGuard 公网地址或域名`：
  填 `files.shenmi175.com`
  不要填 `https://files.shenmi175.com`
  也不要填 `files.shenmi175.com:51820`
- `manager 的 WireGuard 监听端口`：
  填 `51820`
- `manager 的 WireGuard 公钥`：
  在 manager 上执行 `sudo wg show wg0 public-key` 得到的值
- `分配给这台主机的 WireGuard 地址`：
  如果你用本文示例拓扑，填 `10.66.0.3/24`
- `AllowedIPs`：
  如果你用本文示例拓扑，填 `10.66.0.0/24`

执行成功后，向导会输出：

- 本机 WireGuard 公钥
- 本机 WireGuard IP
- 本机 AGENT_TOKEN

### 4. 回到 manager，把 agent 加进 `wg0.conf`

把上一步打印出来的 agent 公钥和 IP 加到 manager 的 `/etc/wireguard/wg0.conf`：

```ini
[Peer]
PublicKey = <agent-public-key>
AllowedIPs = 10.66.0.3/32
```

然后在 manager 上执行：

```bash
sudo systemctl restart wg-quick@wg0
sudo wg show
```

### 5. 在目标主机确认

```bash
sudo file-panel info
sudo wg show
ip -4 addr show wg0
curl -s http://127.0.0.1:3000/api/health
```

如果 `wg0` 正常，`file-panel info` 会显示 `WireGuard IP`。

### 6. 在 manager 面板录入节点

在“节点”页填写：

- 节点名称
- WireGuard IP
- `AGENT_TOKEN`
- 可选 URL

如果 URL 留空，manager 默认使用：

```text
http://<wireguard-ip>:3000
```

## manager 引导式接入

如果你不想手动回填 peer，可以改用 manager 引导式流程：

1. manager 先配置并启动好 `wg0`
2. 在 manager 面板生成一次性引导命令
3. 在目标主机执行：

```bash
sudo bash scripts/install_agent_only.sh
sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>
sudo file-panel info
```

注意：

- 这条流程适用于尚未配置过 `wg0` 的新节点
- 如果目标主机已经存在 `/etc/wireguard/wg0.conf`，引导模式会拒绝覆盖
- 如果你之前跑过失败的 `setup-agent`，它也可能已经留下这个文件

这时先在目标主机执行：

```bash
sudo systemctl disable --now wg-quick@wg0 || true
sudo mv /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak.$(date +%F-%H%M%S)
sudo systemctl reset-failed wg-quick@wg0 || true
```

再重新执行引导命令。

这条流程会自动：

- 生成 agent WireGuard 密钥对
- 写入 `/etc/wireguard/wg0.conf`
- 启动 `wg-quick@wg0`
- 自动把节点登记到 manager
