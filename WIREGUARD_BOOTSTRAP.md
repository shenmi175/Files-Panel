# WireGuard Bootstrap

This is the advanced automatic mode.

For the recommended manual onboarding flow, use [AGENT_ONBOARDING.md](AGENT_ONBOARDING.md).

This document describes the guided manager -> agent bootstrap flow.

## Goal

Add a new target host into the manager-controlled WireGuard network with the smallest possible amount of manual work.

After bootstrap, the target host should:

- run `agent-only`
- have a working `wg0`
- receive an allocated private WireGuard IP
- appear automatically in the manager node directory

## Prerequisites

On the manager:

- `wg0` already exists and is running
- the manager public URL is reachable from the target host
- the WireGuard UDP endpoint is reachable from the target host

On the target host:

- the project repository is already present
- the host can reach the manager public URL

## Manager Steps

1. Open the manager UI.
2. Go to `Nodes`.
3. In `WireGuard 引导接入`, fill:
   - `Manager URL`
   - `WireGuard Endpoint Host`
   - optional node name
   - token expiry
4. Click `生成引导命令`.
5. Copy the generated command block.

## Target Host Steps

Run these commands inside the project directory:

```bash
sudo bash scripts/install_agent_only.sh
sudo file-panel bootstrap-wireguard --manager-url <manager-url> --bootstrap-token <token>
```

## What Happens During Bootstrap

The bootstrap command:

1. reads the local agent role and token
2. generates a WireGuard keypair locally
3. calls the manager bootstrap registration API
4. receives:
   - allocated WireGuard IP
   - manager public key
   - manager endpoint
   - allowed IP range
5. writes `/etc/wireguard/wg0.conf`
6. enables and starts `wg-quick@wg0`
7. lets the manager register the new node automatically

## Safety Rules

- bootstrap tokens are single-use
- bootstrap tokens expire automatically
- rerunning bootstrap on an already configured node is blocked if `/etc/wireguard/wg0.conf` already exists
- browser login is only used on the manager; node-to-manager trust uses `AGENT_TOKEN`

## Troubleshooting

If generation fails on the manager:

- confirm `wg0` exists on the manager
- confirm the manager UI can read WireGuard status
- confirm the manager has a public endpoint host or IP that the target host can reach

If bootstrap fails on the target host:

- run `sudo file-panel info`
- confirm the node role is `agent`
- confirm `AGENT_TOKEN` is present
- confirm the bootstrap token has not expired
- confirm the target host can reach the manager URL and WireGuard UDP endpoint
