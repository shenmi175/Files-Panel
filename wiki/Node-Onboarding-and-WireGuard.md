# Node Onboarding And WireGuard

## 先选流程

### 手动流程

适合你希望自己控制 `wg0.conf`、peer 和地址分配。

- manager 先配置 `wg0`
- 目标主机执行 `sudo file-panel setup-agent`
- 完成后手动把 agent peer 加回 manager
- 再到 manager 面板录入节点

### manager 引导式流程

适合希望由 manager 自动分配地址并自动登记节点。

- manager 先配置 `wg0`
- manager 面板生成引导命令
- 目标主机执行 `sudo file-panel bootstrap-wireguard ...`
- 成功后节点会自动写入 manager 目录

## 手动流程

### 1. manager 先准备好 `wg0`

最小示例：

```ini
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
PrivateKey = <manager-private-key>
```

启动并读取公钥：

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show wg0 public-key
```

如果这里报：

```text
Unable to access interface: No such device
```

说明 manager 的 `wg0` 还没准备好，不要继续执行 agent 侧步骤。

模板见 [wireguard/manager-wg0.example.conf](../wireguard/manager-wg0.example.conf)。

### 2. 目标主机安装 agent-only

```bash
sudo bash scripts/install_agent_only.sh
```

### 3. 目标主机执行向导

```bash
sudo file-panel setup-agent
```

字段填写规则：

- `manager 的 WireGuard 公网地址或域名`
  - 填 `files.example.com`
  - 不要填 `https://files.example.com`
  - 不要填 `files.example.com:51820`
- `manager 的 WireGuard 监听端口`
  - 单独填 `51820`
- `manager 的 WireGuard 公钥`
  - 在 manager 上执行 `sudo wg show wg0 public-key` 得到的值
- `分配给这台主机的 WireGuard 地址`
  - 例如 `10.66.0.3/24`
- `AllowedIPs`
  - 通常填整个 WireGuard 网段，例如 `10.66.0.0/24`

向导成功后会打印：

- 本机 WireGuard 公钥
- 本机 WireGuard IP
- 本机 `AGENT_TOKEN`

### 4. 回到 manager，追加 agent peer

把向导打印的 agent 公钥和 IP 加到 manager 的 `/etc/wireguard/wg0.conf`：

```ini
[Peer]
PublicKey = <agent-public-key>
AllowedIPs = 10.66.0.3/32
```

然后重载：

```bash
sudo systemctl restart wg-quick@wg0
sudo wg show
```

### 5. 在 manager 面板录入节点

填写：

- 节点名称
- WireGuard IP
- `AGENT_TOKEN`
- 可选 URL

如果 URL 留空，manager 默认使用：

```text
http://<wireguard-ip>:3000
```

## manager 引导式流程

### 1. manager 前提

- manager 的 `wg0` 已启动
- manager 面板可以读取 `wg0` 状态
- 目标主机能访问 manager 的公网 URL 和 WireGuard UDP 端口

### 2. 目标主机前提

- 先安装 `agent-only`
- 目标主机应是“干净节点”，即还没有 `/etc/wireguard/wg0.conf`

### 3. manager 面板生成引导命令

在 `Nodes` 页的 `WireGuard 接入指引` 填：

- `Manager URL`
- `WireGuard Endpoint Host`
- 可选节点名
- token 有效期

然后复制生成的命令。

### 4. 目标主机执行

```bash
sudo bash scripts/install_agent_only.sh
sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>
sudo file-panel info
```

引导流程会自动：

- 生成 agent WireGuard 密钥对
- 写入 `/etc/wireguard/wg0.conf`
- 启动 `wg-quick@wg0`
- 自动把节点登记到 manager

## 常见坑

### `setup-agent` 里把 Endpoint 填成了 `https://...`

这是错误输入。
WireGuard 需要的是主机名和端口，不是 URL。

### `bootstrap-wireguard` 提示 `/etc/wireguard/wg0.conf already exists`

说明目标主机不是干净节点，常见于之前跑过失败的 `setup-agent`。

先清理：

```bash
sudo systemctl disable --now wg-quick@wg0 || true
sudo mv /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak.$(date +%F-%H%M%S)
sudo systemctl reset-failed wg-quick@wg0 || true
```

然后重新 bootstrap。

### manager 显示 `failed to reach remote server ... Connection refused`

先不要怀疑 WireGuard。优先检查目标主机上的 agent 是否起来：

```bash
systemctl status files-agent --no-pager
journalctl -u files-agent -n 80 --no-pager
curl -s http://127.0.0.1:3000/api/health
```

### `file-panel info` 没有 `WireGuard IP`

只有 `wg0` 真正启动后，`file-panel info` 才会显示 `WireGuard IP`。
仅执行 `install_agent_only.sh` 不会自动创建 `wg0`。
