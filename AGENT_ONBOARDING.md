# Agent Onboarding

This is the recommended way to add a new target host into the manager node directory.

## Goal

The manager only runs the control plane UI.

Each target host only runs `agent-only`.

You prepare the target host locally, get:

- the target host WireGuard IP
- the target host `AGENT_TOKEN`

Then you go back to the manager UI and add the node manually.

## 1. Prepare the Manager

On the manager host:

- install the manager role
- configure and start `wg0`
- make sure the manager WireGuard endpoint is reachable from the target host
- run `sudo wg show wg0 public-key` and keep that value ready for the target host wizard

Manager `wg0` example:

```ini
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
PrivateKey = <manager-private-key>
```

A reusable template is in [wireguard/manager-wg0.example.conf](wireguard/manager-wg0.example.conf).

## 2. Install the Target Host

On the target host:

```bash
sudo bash scripts/install_agent_only.sh
```

This host does not need the full browser UI.

## 3. Run the Interactive Setup

On the target host:

```bash
sudo file-panel setup-agent
```

The wizard asks for:

- manager WireGuard endpoint host or IP
- manager WireGuard listen port
- manager WireGuard public key
- the WireGuard IP assigned to this target host
- `AllowedIPs`
- optional DNS

Important:

- the manager WireGuard public key must be obtained on the manager host with `sudo wg show wg0 public-key`
- if that command fails with `Unable to access interface: No such device`, the manager `wg0` interface is not ready yet

After confirmation, it will:

- generate the local WireGuard keypair
- write `/etc/wireguard/wg0.conf`
- enable and start `wg-quick@wg0`
- print the local WireGuard public key
- print the final `WireGuard IP`
- print the final `AGENT_TOKEN`

At this point the target host config exists, but you still need to add the target host as a peer on the manager.

On the manager host, append a `[Peer]` block into `/etc/wireguard/wg0.conf`:

```ini
[Peer]
PublicKey = <target-host-public-key>
AllowedIPs = <target-host-wireguard-ip>/32
```

Then reload the manager interface:

```bash
sudo systemctl restart wg-quick@wg0
sudo wg show
```

## 4. Add the Node in the Manager UI

Go back to the manager `Nodes` page and fill:

- node name
- `WireGuard IP`
- `Agent Token`
- optional URL

If URL is left empty, the manager can still build `http://<wireguard-ip>:3000` from the WireGuard IP.

## 5. When to Use the Advanced Bootstrap Mode

There is also an advanced automatic mode:

```bash
sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>
```

Use that only if you want the manager to auto-register the node.

For a simpler and more transparent workflow, `setup-agent` is the recommended path.
