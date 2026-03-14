import {
  dom,
  escapeHtml,
  metricCard,
  normalizeFeatureError,
  request,
  setAccessPlaceholder,
  setConfigPlaceholder,
  setServersPlaceholder,
  showStatus,
  state,
  updateHeroAccess,
} from "./shared.js";

const TOKEN_SWITCH_DELAY_MS = 7000;
const RESTART_RECOVERY_INITIAL_DELAY_MS = 1500;
const RESTART_RECOVERY_INTERVAL_MS = 1200;
const RESTART_RECOVERY_MAX_ATTEMPTS = 20;
let restartResolutionRunId = 0;

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
          ? "服务可能仍在重启，请稍后使用新令牌重新连接。"
          : "服务可能仍在重启，请稍后刷新页面确认配置是否生效。",
        "info",
        { autoClearMs: 10000 }
      );
      return;
    }
    if (tokenWillChange) {
      showStatus("运行配置已生效，请使用新令牌重新连接。", "info", { autoClearMs: 10000 });
      return;
    }
    try {
      await refreshSettings();
      showStatus("运行配置已生效。", "success", { autoClearMs: 6000 });
    } catch {
      showStatus("服务已恢复，请刷新页面确认最新配置。", "info", { autoClearMs: 8000 });
    }
  })();
}

export function renderAccess(payload) {
  state.access = payload;
  updateHeroAccess();

  if (payload.public_url) {
    dom.accessSummaryEl.textContent = payload.restart_pending
      ? `域名已接入：${payload.public_url}，等待服务切回本地监听`
      : `域名已接入：${payload.public_url}`;
  } else if (payload.public_ip_access_enabled) {
    dom.accessSummaryEl.textContent = `当前临时开放 IP:${payload.desired_bind_port} 访问`;
  } else {
    dom.accessSummaryEl.textContent = "当前仅接受本地访问";
  }

  const publicEntry = payload.public_url
    ? payload.public_url
    : payload.public_ip_access_enabled
      ? `http://服务器IP:${payload.desired_bind_port}`
      : "仅本地监听";
  const nginxStatus = payload.nginx_available
    ? payload.nginx_running
      ? "已运行"
      : "已安装，等待 reload"
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
      note: payload.public_ip_access_enabled ? "仍允许通过 IP 访问" : "域名完成后仅保留本地监听",
      tone: "tone-green",
    }),
    metricCard({
      label: "对外入口",
      value: publicEntry,
      note: payload.token_configured ? "访问令牌已配置" : "未配置访问令牌",
      tone: "tone-amber",
    }),
    metricCard({
      label: "Nginx / Certbot",
      value: nginxStatus,
      note: payload.https_enabled
        ? "HTTPS 已就绪"
        : payload.certbot_available
          ? "证书会在域名接入时申请"
          : "未检测到 certbot",
      tone: "tone-olive",
    }),
  ].join("");
}

export function renderConfig(config) {
  state.config = config;
  dom.configAgentNameInput.value = config.agent_name;
  dom.configAgentRootInput.value = config.agent_root;
  dom.configPortInput.value = String(config.port);
  dom.configAgentTokenInput.value = "";
  dom.configCertbotEmailInput.value = config.certbot_email || "";
  dom.configAllowPublicInput.checked = config.allow_public_ip;
  dom.configAllowRestartInput.checked = config.allow_self_restart;
  const sampleInterval = Number(config.resource_sample_interval) || state.resourceSampleInterval || 15;
  const databasePath = config.database_path || "未返回";
  state.resourceSampleInterval = sampleInterval;

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
      label: "访问令牌 / 存储",
      value: config.token_configured ? "访问令牌已配置" : "未配置令牌",
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
  return badges
    .map((badge) => `<span class="server-chip">${escapeHtml(badge)}</span>`)
    .join("");
}

function serverActions(server) {
  if (server.is_local) {
    return `<span class="ghost-chip">当前节点</span>`;
  }
  return `
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
  const enabledCount = state.servers.filter((item) => item.enabled).length;
  dom.serversSummaryEl.textContent =
    `已登记 ${state.servers.length} 个节点，其中 ${enabledCount} 个启用。当前仅维护节点目录。`;

  if (!state.servers.length) {
    setServersPlaceholder("当前还没有登记节点");
    return;
  }

  dom.serversListEl.className = "server-list";
  dom.serversListEl.innerHTML = state.servers
    .map(
      (server) => `
        <div class="server-row">
          <div class="server-main">
            <div class="server-title-row">
              <strong>${escapeHtml(server.name)}</strong>
              <div class="server-chip-row">${serverBadges(server)}</div>
            </div>
            <small>${escapeHtml(server.base_url || "未设置节点 URL")}</small>
            <small>${
              server.last_seen_at
                ? `最近同步 ${escapeHtml(new Date(server.last_seen_at).toLocaleString("zh-CN", { hour12: false }))}`
                : "尚未记录最近同步时间"
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

export async function refreshSettings({ includeConfig = true, includeServers = true } = {}) {
  const results = await Promise.allSettled([
    loadAccess(),
    includeConfig ? loadConfig() : Promise.resolve(),
    includeServers ? loadServers() : Promise.resolve(),
  ]);

  if (results[0].status === "rejected") {
    setAccessPlaceholder(results[0].reason.message);
    throw results[0].reason;
  }
  if (includeConfig && results[1].status === "rejected") {
    setConfigPlaceholder(normalizeFeatureError(results[1].reason, "运行配置"));
  }
  if (includeServers && results[2].status === "rejected") {
    setServersPlaceholder(normalizeFeatureError(results[2].reason, "节点目录"));
  }
}

export async function configureDomain(event) {
  event.preventDefault();
  const domain = dom.domainInput.value.trim();
  if (!domain) {
    showStatus("请输入域名", "error");
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
        ? `域名已接入：${payload.public_url}。服务将自动切回仅本地监听。`
        : `域名已接入：${payload.public_url}`,
      "success"
    );
    await refreshSettings().catch(() => {});
  } catch (error) {
    if (isLikelyRestartInterruption(error)) {
      showStatus("请求在服务重启时中断，请等待几秒后刷新页面确认域名接入状态。", "info");
      return;
    }
    showStatus(error.message, "error");
  }
}

export async function saveConfig(event) {
  event.preventDefault();
  const nextPort = Number(dom.configPortInput.value);
  const nextAgentToken = dom.configAgentTokenInput.value.trim();
  if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
    showStatus("监听端口必须是 1-65535 之间的整数", "error");
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
          ? "运行配置已保存，服务正在重启应用新参数。访问令牌已更新，恢复后请使用新令牌重新连接。"
          : "运行配置已保存，服务正在重启应用新参数。",
        "info"
      );
      scheduleRestartStatusResolution({ tokenWillChange });
      return;
    }

    if (payload.restart_required) {
      showStatus(
        tokenWillChange
          ? "运行配置已保存，请重启服务后使用新令牌重新连接。"
          : "运行配置已保存，请重启服务应用新参数。",
        "info",
        { autoClearMs: 8000 }
      );
      return;
    }

    showStatus("运行配置已保存。", "success", { autoClearMs: 5000 });
  } catch (error) {
    if (dom.configAllowRestartInput.checked && isLikelyRestartInterruption(error)) {
      showStatus("请求在服务重启时中断，请等待几秒后确认配置是否生效。", "info", {
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
  window.prompt("新 AGENT_TOKEN，仅显示这一次，请立即保存：", token);
}

export async function resetAgentToken() {
  if (!window.confirm("重置后旧令牌会失效，继续吗？")) {
    return;
  }

  try {
    const payload = await request("/api/config/reset-token", {
      method: "POST",
    });
    const copied = await copyTokenToClipboard(payload.token);

    if (payload.restart_scheduled) {
      showStatus(
        copied
          ? "令牌已重置，新令牌已复制到剪贴板；页面会在服务重启后自动切换。"
          : "令牌已重置；请立即保存新令牌，页面会在服务重启后自动切换。",
        "info"
      );
      window.setTimeout(() => {
        window.location.reload();
      }, TOKEN_SWITCH_DELAY_MS);
      return;
    }

    revealToken(payload.token);
    showStatus(
      "令牌已重置，但服务未自动重启。请执行 sudo file-panel restart，然后使用新令牌重新登录。",
      "info"
    );
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
    showStatus("请输入节点名称", "error");
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

export async function deleteServer(serverId) {
  const server = state.servers.find((item) => item.id === Number(serverId));
  if (!server) {
    showStatus("节点不存在", "error");
    return;
  }
  if (!window.confirm(`确认删除节点 ${server.name} 吗？`)) {
    return;
  }

  try {
    await request(`/api/servers/${server.id}`, { method: "DELETE" });
    resetServerForm();
    await loadServers();
    showStatus(`已删除节点 ${server.name}`, "success");
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
    showStatus("节点不存在", "error");
    return;
  }

  if (button.dataset.action === "edit") {
    fillServerForm(server);
    return;
  }

  if (button.dataset.action === "delete") {
    deleteServer(server.id).catch((error) => showStatus(error.message, "error"));
  }
}
