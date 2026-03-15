import {
  dom,
  escapeHtml,
  metricCard,
  normalizeFeatureError,
  request,
  setAccessPlaceholder,
  setConfigPlaceholder,
  setServersPlaceholder,
  setUpdatePlaceholder,
  setWireguardBootstrapPlaceholder,
  showStatus,
  state,
  updateHeroAccess,
} from "./shared.js";

const TOKEN_SWITCH_DELAY_MS = 7000;
const RESTART_RECOVERY_INITIAL_DELAY_MS = 1500;
const RESTART_RECOVERY_INTERVAL_MS = 1200;
const RESTART_RECOVERY_MAX_ATTEMPTS = 20;
const RESOURCE_SAMPLE_INTERVAL_OPTIONS = [5, 10, 15];
let restartResolutionRunId = 0;

function defaultBootstrapManagerUrl() {
  const origin = window.location.origin;
  return origin && origin !== "null" ? origin : "";
}

function inferEndpointHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname || "";
  } catch {
    return "";
  }
}

function formatBootstrapTimestamp(rawValue) {
  if (!rawValue) {
    return "-";
  }
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return rawValue;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

async function copyTextWithFallback(text, promptMessage) {
  if (!text) {
    return false;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to prompt fallback.
    }
  }
  window.prompt(promptMessage, text);
  return false;
}

export function renderWireguardBootstrapStatus(payload) {
  state.wireguardBootstrapLoaded = true;
  state.wireguardBootstrapStatus = payload;
  dom.copyWireguardBootstrapButton.disabled = !dom.wireguardBootstrapCommandInput.value.trim();

  if (!dom.wireguardBootstrapManagerUrlInput.value.trim()) {
    dom.wireguardBootstrapManagerUrlInput.value = defaultBootstrapManagerUrl();
  }
  if (!dom.wireguardBootstrapEndpointHostInput.value.trim()) {
    dom.wireguardBootstrapEndpointHostInput.value = inferEndpointHost(
      dom.wireguardBootstrapManagerUrlInput.value.trim()
    );
  }

  const available = Boolean(payload?.available);
  if (!available) {
    dom.wireguardBootstrapSummaryEl.textContent = "Manager wg0 未就绪";
    dom.wireguardBootstrapStatusEl.textContent =
      payload?.message || "请先在 manager 上配置并启动 wg0。准备完成后，可以在目标主机运行 sudo file-panel setup-agent。";
    return;
  }

  const summaryParts = [];
  if (payload.manager_address) {
    summaryParts.push(payload.manager_address);
  }
  if (payload.manager_network) {
    summaryParts.push(payload.manager_network);
  }
  if (payload.listen_port) {
    summaryParts.push(`UDP ${payload.listen_port}`);
  }

  dom.wireguardBootstrapSummaryEl.textContent = `Manager wg0 已就绪 · ${summaryParts.join(" · ")}`;
  dom.wireguardBootstrapStatusEl.textContent =
    "推荐：先在目标主机运行 sudo file-panel setup-agent，通过问答向导完成内网配置，再回到当前页面手动填写 WireGuard IP 和 Agent Token。";
}

export async function loadWireguardBootstrapStatus() {
  const payload = await request("/api/bootstrap/wireguard/status");
  renderWireguardBootstrapStatus(payload);
}

function isLikelyRestartInterruption(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("load failed")
    || message.includes("network request failed")
  );
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForAgentHealth() {
  for (let attempt = 0; attempt < RESTART_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    await wait(attempt === 0 ? RESTART_RECOVERY_INITIAL_DELAY_MS : RESTART_RECOVERY_INTERVAL_MS);
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) {
        continue;
      }
      const payload = await response.json();
      if (payload?.status === "ok") {
        return true;
      }
    } catch {
      // Service may still be restarting.
    }
  }
  return false;
}

function scheduleRestartStatusResolution({ tokenWillChange = false } = {}) {
  const runId = ++restartResolutionRunId;
  void (async () => {
    const recovered = await waitForAgentHealth();
    if (runId !== restartResolutionRunId) {
      return;
    }
    if (!recovered) {
      showStatus(
        tokenWillChange
          ? "服务仍在重启，新的节点令牌可能尚未生效，请稍后刷新页面。"
          : "服务仍在重启，请稍后刷新页面确认配置是否生效。",
        "info",
        { autoClearMs: 10000 }
      );
      return;
    }

    if (tokenWillChange) {
      showStatus("服务已恢复，新的节点令牌已生效，页面即将刷新。", "info", { autoClearMs: 10000 });
      window.setTimeout(() => {
        window.location.reload();
      }, 1200);
      return;
    }

    try {
      await refreshSettings();
      showStatus("运行配置已生效。", "success", { autoClearMs: 6000 });
    } catch {
      showStatus("服务已经恢复，请手动刷新页面确认最新状态。", "info", { autoClearMs: 8000 });
    }
  })();
}

export function renderAccess(payload) {
  state.access = payload;
  state.accessLoaded = true;
  updateHeroAccess();

  if (payload.public_url) {
    dom.accessSummaryEl.textContent = payload.restart_pending
      ? `域名已接入：${payload.public_url}，等待服务重启切换到本地监听。`
      : `域名已接入：${payload.public_url}`;
  } else if (payload.public_ip_access_enabled) {
    dom.accessSummaryEl.textContent = `当前允许通过 IP:${payload.desired_bind_port} 直接访问。`;
  } else {
    dom.accessSummaryEl.textContent = "当前仅允许通过受控入口访问，未开放 IP 直连。";
  }

  const publicEntry = payload.public_url
    ? payload.public_url
    : payload.public_ip_access_enabled
      ? `http://服务器IP:${payload.desired_bind_port}`
      : "等待接入";
  const nginxStatus = payload.nginx_available
    ? payload.nginx_running
      ? "已运行"
      : "可用但未运行"
    : "未安装";

  dom.accessCardsEl.className = "metric-grid";
  dom.accessCardsEl.innerHTML = [
    metricCard({
      label: "当前监听",
      value: `${payload.current_bind_host}:${payload.current_bind_port}`,
      note: payload.restart_pending ? "重启后会切换到新的监听地址" : "当前生效",
      tone: "tone-accent",
    }),
    metricCard({
      label: "目标监听",
      value: `${payload.desired_bind_host}:${payload.desired_bind_port}`,
      note: payload.public_ip_access_enabled ? "仍允许通过 IP:端口 访问" : "域名完成后仅保留本地监听",
      tone: "tone-green",
    }),
    metricCard({
      label: "对外入口",
      value: publicEntry,
      note: payload.token_configured ? "节点令牌已配置" : "尚未配置节点令牌",
      tone: "tone-amber",
    }),
    metricCard({
      label: "Nginx / Certbot",
      value: nginxStatus,
      note: payload.https_enabled
        ? "HTTPS 已就绪"
        : payload.certbot_available
          ? "可用于申请和续期证书"
          : "未安装 certbot",
      tone: "tone-olive",
    }),
  ].join("");
}

export function renderConfig(config) {
  state.config = config;
  state.configLoaded = true;
  const sampleInterval = Number(config.resource_sample_interval) || state.resourceSampleInterval || 5;

  dom.configAgentNameInput.value = config.agent_name;
  dom.configAgentRootInput.value = config.agent_root;
  dom.configPortInput.value = String(config.port);
  dom.configSampleIntervalInput.value = String(sampleInterval);
  dom.configAgentTokenInput.value = "";
  dom.configCertbotEmailInput.value = config.certbot_email || "";
  dom.configAllowPublicInput.checked = config.allow_public_ip;
  dom.configAllowRestartInput.checked = config.allow_self_restart;
  state.resourceSampleInterval = sampleInterval;

  const databasePath = config.database_path || "未检测到";
  dom.configSummaryEl.className = "metric-grid";
  dom.configSummaryEl.innerHTML = [
    metricCard({
      label: "根目录",
      value: config.agent_root,
      note: "文件操作不会越过这个边界",
      tone: "tone-accent",
    }),
    metricCard({
      label: "目标监听",
      value: `${config.desired_bind_host}:${config.desired_bind_port}`,
      note: `当前运行 ${config.current_bind_host}:${config.current_bind_port}`,
      tone: "tone-green",
    }),
    metricCard({
      label: "域名状态",
      value: config.public_domain || "尚未接入域名",
      note: config.restart_pending ? "存在待重启生效的参数" : "SQLite 配置已同步",
      tone: "tone-amber",
    }),
    metricCard({
      label: "令牌 / 存储",
      value: config.token_configured ? "Agent Token 已配置" : "尚未配置 Agent Token",
      note: `采样 ${sampleInterval} 秒，数据库 ${databasePath}`,
      tone: "tone-olive",
    }),
  ].join("");
}

function serverBadges(server) {
  const badges = [];
  badges.push(server.is_local ? "本机节点" : "远程节点");
  badges.push(server.enabled ? "已启用" : "已停用");
  if (server.wireguard_ip) {
    badges.push(`WG ${server.wireguard_ip}`);
  }
  return badges.map((badge) => `<span class="server-chip">${escapeHtml(badge)}</span>`).join("");
}

function isSelectedServer(server) {
  if (server.is_local) {
    return state.selectedServerId === null;
  }
  return state.selectedServerId === server.id;
}

function serverActions(server) {
  const selected = isSelectedServer(server);
  const selectLabel = selected ? "当前查看" : "切换查看";

  if (server.is_local) {
    return `
      <button type="button" class="secondary server-action ${selected ? "is-current" : ""}" data-action="select" data-id="${server.id}">
        ${selectLabel}
      </button>
    `;
  }
  return `
    <button type="button" class="secondary server-action ${selected ? "is-current" : ""}" data-action="select" data-id="${server.id}">
      ${selectLabel}
    </button>
    <button type="button" class="secondary server-action" data-action="edit" data-id="${server.id}">
      编辑
    </button>
    <button type="button" class="secondary server-action" data-action="delete" data-id="${server.id}">
      删除
    </button>
  `;
}

export function resetServerForm() {
  dom.serverIdInput.value = "";
  dom.serverNameInput.value = "";
  dom.serverBaseUrlInput.value = "";
  dom.serverWireguardIpInput.value = "";
  dom.serverTokenInput.value = "";
  dom.serverEnabledInput.checked = true;
}

function fillServerForm(server) {
  dom.serverIdInput.value = String(server.id);
  dom.serverNameInput.value = server.name;
  dom.serverBaseUrlInput.value = server.base_url || "";
  dom.serverWireguardIpInput.value = server.wireguard_ip || "";
  dom.serverTokenInput.value = "";
  dom.serverEnabledInput.checked = server.enabled;
}

export function renderServers(payload) {
  state.servers = payload.items || [];
  state.serversLoaded = true;

  const selectedServer = state.selectedServerId === null
    ? state.servers.find((item) => item.is_local)
    : state.servers.find((item) => item.id === state.selectedServerId && item.enabled);
  if (!selectedServer) {
    state.selectedServerId = null;
    state.selectedServerName = null;
  } else {
    state.selectedServerName = selectedServer.name;
  }

  const enabledCount = state.servers.filter((item) => item.enabled).length;
  dom.serversSummaryEl.textContent = `已登记 ${state.servers.length} 个节点，启用 ${enabledCount} 个；当前查看 ${state.selectedServerName || "本机节点"}`;

  if (!state.servers.length) {
    setServersPlaceholder("暂未登记任何节点");
    return;
  }

  dom.serversListEl.className = "server-list";
  dom.serversListEl.innerHTML = state.servers
    .map(
      (server) => `
        <div class="server-row ${isSelectedServer(server) ? "is-selected" : ""}">
          <div class="server-main">
            <div class="server-title-row">
              <strong>${escapeHtml(server.name)}</strong>
              <div class="server-chip-row">${serverBadges(server)}</div>
            </div>
            <small>${escapeHtml(server.base_url || "未配置节点 URL")}</small>
            <small>${
              server.last_seen_at
                ? `最近连通 ${escapeHtml(new Date(server.last_seen_at).toLocaleString("zh-CN", { hour12: false }))}`
                : "尚未成功连接过该节点"
            }</small>
          </div>
          <div class="server-actions">
            ${serverActions(server)}
          </div>
        </div>
      `
    )
    .join("");
}

export async function loadAccess() {
  renderAccess(await request("/api/access"));
}

export async function loadConfig() {
  renderConfig(await request("/api/config"));
}

export async function loadServers() {
  const payload = await request("/api/servers");
  renderServers({ items: Array.isArray(payload?.items) ? payload.items : [] });
}

export function renderUpdateStatus(payload) {
  state.updateStatusLoaded = true;
  state.updateStatus = payload;

  if (dom.nodeUpdateSummaryEl) {
    const targetLabel = state.selectedServerName || "local manager";
    const sourceLabel = payload?.source_dir || "not linked";
    dom.nodeUpdateSummaryEl.textContent = `${targetLabel}: source ${sourceLabel}`;
  }

  if (dom.nodeUpdateCurrentVersionEl) {
    dom.nodeUpdateCurrentVersionEl.textContent = payload?.current_version || "-";
  }

  if (dom.nodeUpdateLatestVersionEl) {
    dom.nodeUpdateLatestVersionEl.textContent = payload?.latest_version || "-";
  }

  if (dom.nodeUpdateAvailabilityEl) {
    if (!payload?.auto_update_available) {
      dom.nodeUpdateAvailabilityEl.textContent = "Unavailable";
    } else if (payload?.update_available) {
      dom.nodeUpdateAvailabilityEl.textContent = "Update Available";
    } else if (payload?.current_version && payload?.latest_version) {
      dom.nodeUpdateAvailabilityEl.textContent = "Up to Date";
    } else {
      dom.nodeUpdateAvailabilityEl.textContent = "Check Failed";
    }
  }

  if (dom.triggerNodeUpdateButton) {
    const status = String(payload?.status || "").toLowerCase();
    const busy = status === "scheduled" || status === "running";
    dom.triggerNodeUpdateButton.disabled = !payload?.auto_update_available || busy;
    dom.triggerNodeUpdateButton.textContent = busy ? "Update Running" : "Update Now";
  }

  if (dom.triggerAllNodeUpdatesButton) {
    const hasRemoteNodes = state.servers.some((item) => !item.is_local && item.enabled);
    dom.triggerAllNodeUpdatesButton.disabled = !hasRemoteNodes;
  }

  if (!dom.nodeUpdateStatusEl) {
    return;
  }

  const parts = [];
  if (payload?.update_available) {
    parts.push("update available");
  } else if (payload?.current_version && payload?.latest_version) {
    parts.push("already latest");
  } else {
    parts.push(payload?.auto_update_available ? "version check unavailable" : "auto-update unavailable");
  }
  if (payload?.git_repo) {
    parts.push("git repo linked");
  } else if (payload?.project_dir_valid) {
    parts.push("no git repo");
  } else {
    parts.push("source dir invalid");
  }
  if (payload?.status) {
    parts.push(`status: ${payload.status}`);
  }
  if (payload?.mode) {
    parts.push(`mode: ${payload.mode}`);
  }
  if (payload?.message) {
    parts.push(payload.message);
  }
  dom.nodeUpdateStatusEl.textContent = parts.join(" · ");
}

export async function loadUpdateStatus() {
  const payload = await request("/api/update/status");
  renderUpdateStatus(payload);
}

export async function generateWireguardBootstrap(event) {
  event.preventDefault();

  const managerUrl = dom.wireguardBootstrapManagerUrlInput.value.trim() || defaultBootstrapManagerUrl();
  const endpointHost =
    dom.wireguardBootstrapEndpointHostInput.value.trim() || inferEndpointHost(managerUrl);
  const expiresInMinutes = Number(dom.wireguardBootstrapExpiryInput.value || "20");
  const nodeName = dom.wireguardBootstrapNodeNameInput.value.trim();

  if (!managerUrl) {
    showStatus("请先填写 manager 对外地址", "error");
    return;
  }

  dom.generateWireguardBootstrapButton.disabled = true;
  try {
    const payload = await request("/api/bootstrap/wireguard/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manager_url: managerUrl,
        endpoint_host: endpointHost || null,
        node_name: nodeName || null,
        expires_in_minutes: expiresInMinutes,
      }),
    });

    dom.wireguardBootstrapManagerUrlInput.value = payload.manager_url;
    dom.wireguardBootstrapEndpointHostInput.value = payload.endpoint_host;
    dom.wireguardBootstrapCommandInput.value = payload.combined_command;
    dom.copyWireguardBootstrapButton.disabled = false;
    dom.wireguardBootstrapSummaryEl.textContent =
      `一次性引导命令已生成 · ${formatBootstrapTimestamp(payload.expires_at)} 前有效`;
    dom.wireguardBootstrapStatusEl.textContent =
      "这是高级自动接入模式。若你希望手动登记节点，也可以改为在目标主机运行 sudo file-panel setup-agent，拿到 WireGuard IP 和 Agent Token 后回到上面的节点表单填写。";

    showStatus("WireGuard 引导命令已生成", "success", { autoClearMs: 5000 });
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    dom.generateWireguardBootstrapButton.disabled = false;
  }
}

export async function copyWireguardBootstrapCommand() {
  const command = dom.wireguardBootstrapCommandInput.value.trim();
  if (!command) {
    showStatus("请先生成引导命令", "error");
    return;
  }

  const copied = await copyTextWithFallback(command, "复制这段引导命令");
  showStatus(copied ? "引导命令已复制" : "引导命令已显示，可手动复制", "success", {
    autoClearMs: 4000,
  });
}

export async function refreshSettings({ includeConfig = true, includeServers = true } = {}) {
  const results = await Promise.allSettled([
    loadAccess(),
    includeConfig ? loadConfig() : Promise.resolve(),
    includeServers ? loadServers() : Promise.resolve(),
    includeServers ? loadWireguardBootstrapStatus() : Promise.resolve(),
    includeServers ? loadUpdateStatus() : Promise.resolve(),
  ]);

  if (results[0].status === "rejected") {
    state.accessLoaded = false;
    setAccessPlaceholder(results[0].reason.message);
    throw results[0].reason;
  }
  if (includeConfig && results[1].status === "rejected") {
    state.configLoaded = false;
    setConfigPlaceholder(normalizeFeatureError(results[1].reason, "运行配置"));
  }
  if (includeServers && results[2].status === "rejected") {
    state.serversLoaded = false;
    setServersPlaceholder(normalizeFeatureError(results[2].reason, "节点目录"));
  }
  if (includeServers && results[3].status === "rejected") {
    state.wireguardBootstrapLoaded = false;
    setWireguardBootstrapPlaceholder(
      normalizeFeatureError(results[3].reason, "WireGuard 引导接入")
    );
  }
  if (includeServers && results[4].status === "rejected") {
    state.updateStatusLoaded = false;
    setUpdatePlaceholder(normalizeFeatureError(results[4].reason, "Auto Update"));
  }
}

export async function configureDomain(event) {
  event.preventDefault();
  const domain = dom.domainInput.value.trim();
  if (!domain) {
    showStatus("请填写域名。", "error");
    return;
  }

  try {
    const payload = await request("/api/access/domain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    dom.domainInput.value = "";
    showStatus(
      payload.restart_scheduled
        ? `域名已接入：${payload.public_url}，服务正在重启应用新入口。`
        : `域名已接入：${payload.public_url}`,
      "success"
    );
    await refreshSettings().catch(() => {});
  } catch (error) {
    if (isLikelyRestartInterruption(error)) {
      showStatus("服务正在重启切换域名入口，请稍后刷新确认。", "info");
      return;
    }
    showStatus(error.message, "error");
  }
}

export async function saveConfig(event) {
  event.preventDefault();
  const nextPort = Number(dom.configPortInput.value);
  const nextSampleInterval = Number(dom.configSampleIntervalInput.value);
  const nextAgentToken = dom.configAgentTokenInput.value.trim();

  if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
    showStatus("监听端口必须在 1 到 65535 之间。", "error");
    return;
  }
  if (!RESOURCE_SAMPLE_INTERVAL_OPTIONS.includes(nextSampleInterval)) {
    showStatus("采样间隔只能是 5、10、15 秒。", "error");
    return;
  }

  try {
    const payload = await request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: dom.configAgentNameInput.value.trim(),
        agent_root: dom.configAgentRootInput.value.trim(),
        port: nextPort,
        resource_sample_interval: nextSampleInterval,
        agent_token: nextAgentToken,
        allow_public_ip: dom.configAllowPublicInput.checked,
        certbot_email: dom.configCertbotEmailInput.value.trim(),
        allow_self_restart: dom.configAllowRestartInput.checked,
      }),
    });
    renderConfig(payload.config);
    await loadAccess().catch(() => {});
    const tokenWillChange = Boolean(nextAgentToken);

    if (payload.restart_scheduled) {
      showStatus(
        tokenWillChange
          ? "运行配置已保存，服务正在重启并应用新的节点令牌。"
          : "运行配置已保存，服务正在重启应用新参数。",
        "info"
      );
      scheduleRestartStatusResolution({ tokenWillChange });
      return;
    }

    if (payload.restart_required) {
      showStatus(
        tokenWillChange
          ? "配置已保存；需要手动重启服务后，新节点令牌才会生效。"
          : "配置已保存；需要手动重启服务后，新参数才会生效。",
        "info",
        { autoClearMs: 8000 }
      );
      return;
    }

    showStatus("运行配置已保存。", "success", { autoClearMs: 5000 });
  } catch (error) {
    if (dom.configAllowRestartInput.checked && isLikelyRestartInterruption(error)) {
      showStatus("服务正在重启应用新参数，请稍后刷新确认。", "info", {
        autoClearMs: 10000,
      });
      scheduleRestartStatusResolution({ tokenWillChange: Boolean(nextAgentToken) });
      return;
    }
    showStatus(error.message, "error");
  }
}

async function copyTokenToClipboard(token) {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(token);
    return true;
  } catch {
    return false;
  }
}

function revealToken(token) {
  window.prompt("新的 AGENT_TOKEN 已生成，请妥善保存：", token);
}

export async function resetAgentToken() {
  if (!window.confirm("确认重置当前节点的 AGENT_TOKEN 吗？")) {
    return;
  }

  try {
    const payload = await request("/api/config/reset-token", {
      method: "POST",
    });
    const copied = await copyTokenToClipboard(payload.token);
    if (!copied) {
      revealToken(payload.token);
    }

    if (payload.restart_scheduled) {
      showStatus(
        copied
          ? "新的 AGENT_TOKEN 已复制，服务正在重启应用。"
          : "新的 AGENT_TOKEN 已生成，服务正在重启应用。",
        "info"
      );
      window.setTimeout(() => {
        window.location.reload();
      }, TOKEN_SWITCH_DELAY_MS);
      return;
    }

    revealToken(payload.token);
    showStatus("新的 AGENT_TOKEN 已生成，重启服务后生效。", "info");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function saveServer(event) {
  event.preventDefault();
  const serverId = dom.serverIdInput.value.trim();
  const payload = {
    name: dom.serverNameInput.value.trim(),
    base_url: dom.serverBaseUrlInput.value.trim(),
    auth_token: dom.serverTokenInput.value.trim(),
    wireguard_ip: dom.serverWireguardIpInput.value.trim(),
    enabled: dom.serverEnabledInput.checked,
  };

  if (!payload.name) {
    showStatus("请填写节点名称。", "error");
    return;
  }

  try {
    const response = await request(serverId ? `/api/servers/${serverId}` : "/api/servers", {
      method: serverId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    resetServerForm();
    await loadServers();
    showStatus(response.message, "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function triggerNodeUpdate(event) {
  event?.preventDefault?.();

  const payload = {
    mode: dom.nodeUpdateModeInput?.value || "quick",
    pull_latest: Boolean(dom.nodeUpdatePullLatestInput?.checked),
  };

  try {
    const response = await request("/api/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderUpdateStatus(response.status);
    showStatus(
      `${state.selectedServerName || "local manager"} update scheduled: ${payload.mode}`,
      "info",
      { autoClearMs: 8000 }
    );

    if (state.selectedServerId === null) {
      window.setTimeout(() => {
        window.location.reload();
      }, 12000);
      return;
    }

    window.setTimeout(() => {
      loadUpdateStatus().catch(() => {});
    }, 5000);
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function triggerAllNodeUpdates() {
  const enabledRemoteNodes = state.servers.filter((item) => !item.is_local && item.enabled);
  if (!enabledRemoteNodes.length) {
    showStatus("No enabled remote agent nodes available", "error");
    return;
  }

  if (
    !window.confirm(
      `Schedule update for ${enabledRemoteNodes.length} remote agent node(s)? Manager will not be updated by this action.`
    )
  ) {
    return;
  }

  const payload = {
    mode: dom.nodeUpdateModeInput?.value || "quick",
    pull_latest: Boolean(dom.nodeUpdatePullLatestInput?.checked),
  };

  dom.triggerAllNodeUpdatesButton.disabled = true;
  try {
    const response = await request("/api/update/all-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const summary = `${response.scheduled_nodes}/${response.total_nodes} agent nodes scheduled`;
    const firstFailure = Array.isArray(response.results)
      ? response.results.find((item) => !item.scheduled)
      : null;
    showStatus(
      firstFailure
        ? `${summary}; ${firstFailure.server_name}: ${firstFailure.message}`
        : `${summary}; mode=${response.mode}`,
      firstFailure ? "info" : "success",
      { autoClearMs: 10000 }
    );
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    if (dom.triggerAllNodeUpdatesButton) {
      const hasRemoteNodes = state.servers.some((item) => !item.is_local && item.enabled);
      dom.triggerAllNodeUpdatesButton.disabled = !hasRemoteNodes;
    }
  }
}

export async function deleteServer(serverId) {
  const server = state.servers.find((item) => item.id === Number(serverId));
  if (!server) {
    showStatus("节点不存在。", "error");
    return;
  }
  if (!window.confirm(`确认删除节点 ${server.name} 吗？`)) {
    return;
  }

  try {
    await request(`/api/servers/${server.id}`, { method: "DELETE" });
    resetServerForm();
    await loadServers();
    if (state.selectedServerId === server.id) {
      window.dispatchEvent(
        new CustomEvent("server:selected", {
          detail: { serverId: null, serverName: null },
        })
      );
    }
    showStatus(`节点 ${server.name} 已删除。`, "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export function handleServersClick(event) {
  const button = event.target.closest(".server-action");
  if (!button) {
    return;
  }

  const server = state.servers.find((item) => item.id === Number(button.dataset.id));
  if (!server) {
    showStatus("节点不存在。", "error");
    return;
  }

  if (button.dataset.action === "edit") {
    fillServerForm(server);
    return;
  }

  if (button.dataset.action === "select") {
    window.dispatchEvent(
      new CustomEvent("server:selected", {
        detail: {
          serverId: server.is_local ? null : server.id,
          serverName: server.name,
        },
      })
    );
    return;
  }

  if (button.dataset.action === "delete") {
    deleteServer(server.id).catch((error) => showStatus(error.message, "error"));
  }
}
