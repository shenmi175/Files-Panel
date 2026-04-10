import {
  dom,
  escapeHtml,
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
const UPDATE_CHANNEL_OPTIONS = ["stable", "rc", "main"];
let restartResolutionRunId = 0;

function setText(node, value) {
  if (!node) {
    return;
  }
  const nextValue = String(value ?? "");
  if (node.textContent !== nextValue) {
    node.textContent = nextValue;
  }
}

function setInnerHTML(node, value) {
  if (!node) {
    return;
  }
  const nextValue = String(value ?? "");
  if (node.innerHTML !== nextValue) {
    node.innerHTML = nextValue;
  }
}

function setValue(node, value, { skipWhileFocused = false } = {}) {
  if (!node) {
    return;
  }
  if (skipWhileFocused && document.activeElement === node) {
    return;
  }
  const nextValue = String(value ?? "");
  if (node.value !== nextValue) {
    node.value = nextValue;
  }
}

function setChecked(node, checked, { skipWhileFocused = false } = {}) {
  if (!node) {
    return;
  }
  if (skipWhileFocused && document.activeElement === node) {
    return;
  }
  const nextValue = Boolean(checked);
  if (node.checked !== nextValue) {
    node.checked = nextValue;
  }
}

function syncSelectOptions(node, values) {
  if (!node || !Array.isArray(values) || !values.length) {
    return;
  }
  const current = Array.from(node.options).map((option) => option.value);
  if (current.length === values.length && current.every((value, index) => value === values[index])) {
    return;
  }
  node.innerHTML = values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
}

function renderTextMetricCardMarkup(card, attrName) {
  return `
    <div class="metric-card ${escapeHtml(card.tone)} is-text ${escapeHtml(card.cardClass || "")}" ${attrName}="${escapeHtml(card.key)}">
      <div class="metric-body">
        <div class="metric-copy">
          <span>${escapeHtml(card.label)}</span>
          <strong data-role="value">${escapeHtml(card.value)}</strong>
          <small data-role="note">${escapeHtml(card.note)}</small>
        </div>
      </div>
    </div>
  `;
}

function ensureTextMetricScaffold(container, cards, attrName) {
  if (container.querySelectorAll(`[${attrName}]`).length === cards.length) {
    return;
  }
  container.className = "metric-grid";
  container.innerHTML = cards.map((card) => renderTextMetricCardMarkup(card, attrName)).join("");
}

function patchTextMetricCards(container, cards, attrName) {
  ensureTextMetricScaffold(container, cards, attrName);
  container.className = "metric-grid";
  cards.forEach((card) => {
    const cardEl = container.querySelector(`[${attrName}="${card.key}"]`);
    if (!cardEl) {
      return;
    }
    setText(cardEl.querySelector('[data-role="value"]'), card.value);
    setText(cardEl.querySelector('[data-role="note"]'), card.note);
  });
}

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

function formatUpdateTimestamp(rawValue) {
  if (!rawValue) {
    return "";
  }
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return rawValue;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function currentUpdateTargetLabel() {
  return state.selectedServerName || "当前管理机";
}

function selectedUpdateChannel() {
  return (
    state.updateChannelOverride
    || dom.nodeUpdateChannelInput?.value
    || state.updateStatus?.channel
    || "main"
  );
}

function updateModeLabel(mode) {
  switch (mode) {
    case "quick":
      return "快速同步";
    case "redeploy":
      return "重新部署";
    case "full-install":
      return "完整安装";
    default:
      return mode || "-";
  }
}

function updateRunStateLabel(status) {
  switch (String(status || "").toLowerCase()) {
    case "idle":
      return "空闲";
    case "scheduled":
      return "已排队";
    case "running":
      return "更新中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status || "";
  }
}

function updateAvailabilityLabel(payload) {
  if (!payload?.auto_update_available) {
    return "不可用";
  }
  if (payload?.git_repo && payload?.channel_exists === false) {
    return "通道未发布";
  }
  if (payload?.update_available) {
    return "有新版本";
  }
  if (payload?.current_version && payload?.latest_version) {
    return "已是最新";
  }
  return "检查失败";
}

function translateUpdateMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "";
  }

  const replacements = [
    ["update scheduled", "已安排更新任务"],
    ["update running", "更新任务执行中"],
    ["update completed", "更新完成"],
    ["update failed; inspect update.log", "更新失败，请检查 update.log"],
    [
      "automatic update is unavailable on this node; reinstall once from the source repository first",
      "当前节点暂不可自动更新，请先从源码仓库重新安装一次。",
    ],
    [
      "this node has no linked git repository; disable pull-latest or reinstall from a git checkout first",
      "当前节点未关联 Git 仓库；请关闭更新前拉取，或从 Git 工作区重新安装。",
    ],
    [
      "changing release channel requires pull-latest to stay enabled",
      "切换发布通道时必须保持更新前执行 Git 拉取。",
    ],
    [
      "working tree has uncommitted changes; refusing to switch update channels automatically",
      "源码目录存在未提交改动，已拒绝自动切换发布通道。",
    ],
    [
      "update helper is unavailable; previous update state cannot continue",
      "更新提权能力不可用，之前的更新状态无法继续。",
    ],
    [
      "update status is stale; worker process is no longer running",
      "更新状态已过期；后台更新进程已经不存在。",
    ],
    [
      "scheduled update did not start; previous state is stale",
      "已排队的更新任务并未真正启动；当前状态已过期。",
    ],
    [
      "an update is already running on this node",
      "当前节点已有更新任务在运行。",
    ],
    ["no enabled remote nodes are configured", "没有启用的远程节点。"],
    ["git is not installed on this node", "当前节点未安装 Git。"],
    ["automatic update source directory is invalid", "自动更新源码目录无效"],
    ["source directory is not a git repository", "源码目录不是 Git 仓库"],
  ];

  for (const [source, translated] of replacements) {
    if (raw === source) {
      return translated;
    }
    if (raw.startsWith(`${source}:`)) {
      return `${translated}：${raw.slice(source.length + 1).trim()}`;
    }
  }

  const missingChannelMatch = raw.match(/^release channel '([^']+)' has not been published to origin$/);
  if (missingChannelMatch) {
    return `所选发布通道尚未发布到远端仓库：${missingChannelMatch[1]}`;
  }

  if (/^update status is stale[;,] worker process is no longer running$/i.test(raw)) {
    return "更新状态已过期；后台更新进程已经不存在。";
  }

  return raw;
}

function updateToneForRunState(status) {
  switch (String(status || "").toLowerCase()) {
    case "scheduled":
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function renderUpdateStatusChip(label, tone = "neutral") {
  return `<span class="update-status-chip is-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function buildUpdateStatusMarkup(payload) {
  const chips = [];

  if (!payload?.auto_update_available) {
    if (!payload?.project_dir_valid) {
      chips.push(renderUpdateStatusChip("源码目录无效", "danger"));
    } else {
      chips.push(renderUpdateStatusChip("缺少提权更新能力", "danger"));
    }
  } else if (payload?.git_repo && payload?.channel_exists === false) {
    chips.push(renderUpdateStatusChip(`通道未发布：${payload.channel}`, "danger"));
  } else if (payload?.update_available) {
    chips.push(renderUpdateStatusChip("发现新版本", "warning"));
  } else if (payload?.current_version && payload?.latest_version) {
    chips.push(renderUpdateStatusChip("已是最新版本", "success"));
  } else {
    chips.push(renderUpdateStatusChip("版本检查暂不可用", "neutral"));
  }

  if (payload?.git_repo) {
    chips.push(renderUpdateStatusChip("已关联 Git 仓库", "success"));
  } else if (payload?.project_dir_valid) {
    chips.push(renderUpdateStatusChip("未关联 Git 仓库", "warning"));
  }

  if (payload?.channel) {
    chips.push(renderUpdateStatusChip(`通道：${payload.channel}`));
  }

  if (payload?.channel_ref) {
    chips.push(
      renderUpdateStatusChip(
        payload.channel_exists ? `跟踪 ${payload.channel_ref}` : `远端缺少 ${payload.channel_ref}`,
        payload.channel_exists ? "success" : "danger"
      )
    );
  }

  if (payload?.status) {
    chips.push(
      renderUpdateStatusChip(
        `任务：${updateRunStateLabel(payload.status)}`,
        updateToneForRunState(payload.status)
      )
    );
  }

  if (payload?.mode) {
    chips.push(renderUpdateStatusChip(`方式：${updateModeLabel(payload.mode)}`));
  }

  if (payload?.pull_latest !== null && payload?.pull_latest !== undefined) {
    chips.push(
      renderUpdateStatusChip(payload.pull_latest ? "更新前执行 Git 拉取" : "跳过 Git 拉取")
    );
  }

  if (payload?.latest_checked_at) {
    chips.push(
      renderUpdateStatusChip(`最近检查：${formatUpdateTimestamp(payload.latest_checked_at)}`)
    );
  }

  const translatedMessage = translateUpdateMessage(payload?.message);
  const note = translatedMessage
    ? `<p class="update-status-note">${escapeHtml(translatedMessage)}</p>`
    : "";

  return `
    <div class="update-status-badges">${chips.join("")}</div>
    ${note}
  `;
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
      payload?.message || "请先配置并启动 wg0。";
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
  dom.wireguardBootstrapStatusEl.textContent = "可以生成引导命令。";
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

  patchTextMetricCards(
    dom.accessCardsEl,
    [
      {
        key: "current-bind",
        label: "当前监听",
        value: `${payload.current_bind_host}:${payload.current_bind_port}`,
        note: payload.restart_pending ? "重启后会切换到新的监听地址" : "当前生效",
        tone: "tone-accent",
      },
      {
        key: "desired-bind",
        label: "目标监听",
        value: `${payload.desired_bind_host}:${payload.desired_bind_port}`,
        note: payload.public_ip_access_enabled ? "仍允许通过 IP:端口 访问" : "域名完成后仅保留本地监听",
        tone: "tone-green",
      },
      {
        key: "public-entry",
        label: "对外入口",
        value: publicEntry,
        note: payload.token_configured ? "节点令牌已配置" : "尚未配置节点令牌",
        tone: "tone-amber",
      },
      {
        key: "nginx-certbot",
        label: "Nginx / Certbot",
        value: nginxStatus,
        note: payload.https_enabled
          ? "HTTPS 已就绪"
          : payload.certbot_available
            ? "可用于申请和续期证书"
            : "未安装 certbot",
        tone: "tone-olive",
      },
    ],
    "data-access-card"
  );
}

export function renderConfig(config) {
  state.config = config;
  state.configLoaded = true;
  const sampleInterval = Number(config.resource_sample_interval) || state.resourceSampleInterval || 5;

  setValue(dom.configAgentNameInput, config.agent_name, { skipWhileFocused: true });
  setValue(dom.configAgentRootInput, config.agent_root, { skipWhileFocused: true });
  setValue(dom.configPortInput, config.port, { skipWhileFocused: true });
  setValue(dom.configSampleIntervalInput, sampleInterval, { skipWhileFocused: true });
  syncSelectOptions(dom.configUpdateChannelInput, config.available_update_channels || UPDATE_CHANNEL_OPTIONS);
  setValue(dom.configUpdateChannelInput, config.update_channel || "main", { skipWhileFocused: true });
  if (!dom.configAgentTokenInput.value.trim() && document.activeElement !== dom.configAgentTokenInput) {
    setValue(dom.configAgentTokenInput, "");
  }
  setValue(dom.configCertbotEmailInput, config.certbot_email || "", { skipWhileFocused: true });
  setChecked(dom.configAllowPublicInput, config.allow_public_ip, { skipWhileFocused: true });
  setChecked(dom.configAllowRestartInput, config.allow_self_restart, { skipWhileFocused: true });
  state.resourceSampleInterval = sampleInterval;

  const databasePath = config.database_path || "未检测到";
  patchTextMetricCards(
    dom.configSummaryEl,
    [
      {
        key: "root",
        label: "根目录",
        value: config.agent_root,
        note: "文件操作不会越过这个边界",
        tone: "tone-accent",
      },
      {
        key: "target-bind",
        label: "目标监听",
        value: `${config.desired_bind_host}:${config.desired_bind_port}`,
        note: `当前运行 ${config.current_bind_host}:${config.current_bind_port}`,
        tone: "tone-green",
      },
      {
        key: "domain",
        label: "域名状态",
        value: config.public_domain || "尚未接入域名",
        note: config.restart_pending ? "存在待重启生效的参数" : "SQLite 配置已同步",
        tone: "tone-amber",
      },
      {
        key: "token-storage",
        label: "令牌 / 存储",
        value: config.token_configured ? "Agent Token 已配置" : "尚未配置 Agent Token",
        note: `通道 ${config.update_channel || "main"}，采样 ${sampleInterval} 秒，数据库 ${databasePath}`,
        tone: "tone-olive",
      },
    ],
    "data-config-card"
  );
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

function serverKey(server) {
  return server.is_local ? `local:${server.name}` : `remote:${server.id}`;
}

function createServerRow(server) {
  const row = document.createElement("div");
  row.innerHTML = `
    <div class="server-main">
      <div class="server-title-row">
        <strong data-role="name"></strong>
        <div class="server-chip-row" data-role="badges"></div>
      </div>
      <small data-role="base-url"></small>
      <small data-role="last-seen"></small>
    </div>
    <div class="server-actions" data-role="actions"></div>
  `;
  updateServerRow(row, server);
  return row;
}

function updateServerRow(row, server) {
  row.className = `server-row${isSelectedServer(server) ? " is-selected" : ""}`;
  row.dataset.serverKey = serverKey(server);
  setText(row.querySelector('[data-role="name"]'), server.name);
  setInnerHTML(row.querySelector('[data-role="badges"]'), serverBadges(server));
  setText(row.querySelector('[data-role="base-url"]'), server.base_url || "未配置节点 URL");
  setText(
    row.querySelector('[data-role="last-seen"]'),
    server.last_seen_at
      ? `最近连通 ${new Date(server.last_seen_at).toLocaleString("zh-CN", { hour12: false })}`
      : "尚未成功连接过该节点"
  );
  setInnerHTML(row.querySelector('[data-role="actions"]'), serverActions(server));
}

function syncServerRows(servers) {
  const existingRows = new Map(
    Array.from(dom.serversListEl.querySelectorAll(".server-row")).map((row) => [row.dataset.serverKey, row])
  );
  const fragment = document.createDocumentFragment();
  servers.forEach((server) => {
    const key = serverKey(server);
    const row = existingRows.get(key) || createServerRow(server);
    updateServerRow(row, server);
    fragment.appendChild(row);
  });
  dom.serversListEl.replaceChildren(fragment);
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
  syncServerRows(state.servers);
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
  if (!state.updateChannelOverride) {
    state.updateChannelOverride = payload?.channel || null;
  }

  if (dom.nodeUpdateSummaryEl) {
    const targetLabel = currentUpdateTargetLabel();
    const sourceLabel = payload?.source_dir || "未关联源码目录";
    const channelLabel = payload?.channel || "main";
    const checkedAt = payload?.latest_checked_at
      ? ` · 最近检查 ${formatUpdateTimestamp(payload.latest_checked_at)}`
      : "";
    dom.nodeUpdateSummaryEl.textContent = `目标节点：${targetLabel} · 发布通道：${channelLabel} · 源码目录：${sourceLabel}${checkedAt}`;
  }

  if (dom.nodeUpdateCurrentVersionEl) {
    dom.nodeUpdateCurrentVersionEl.textContent = payload?.current_version || "-";
  }

  if (dom.nodeUpdateChannelLabelEl) {
    dom.nodeUpdateChannelLabelEl.textContent = payload?.channel || "main";
  }

  if (dom.nodeUpdateLatestVersionEl) {
    dom.nodeUpdateLatestVersionEl.textContent = payload?.latest_version || "未获取";
  }

  if (dom.nodeUpdateAvailabilityEl) {
    dom.nodeUpdateAvailabilityEl.textContent = updateAvailabilityLabel(payload);
  }

  if (dom.nodeUpdateModeInput && payload?.mode) {
    setValue(dom.nodeUpdateModeInput, payload.mode, { skipWhileFocused: true });
  }

  if (dom.nodeUpdateChannelInput) {
    syncSelectOptions(dom.nodeUpdateChannelInput, payload?.available_channels || UPDATE_CHANNEL_OPTIONS);
    setValue(dom.nodeUpdateChannelInput, payload?.channel || "main", { skipWhileFocused: true });
  }

  if (dom.nodeUpdatePullLatestInput && payload?.pull_latest !== null && payload?.pull_latest !== undefined) {
    setChecked(dom.nodeUpdatePullLatestInput, payload.pull_latest, { skipWhileFocused: true });
  }

  if (dom.triggerNodeUpdateButton) {
    const status = String(payload?.status || "").toLowerCase();
    const busy = status === "scheduled" || status === "running";
    dom.triggerNodeUpdateButton.disabled = !payload?.auto_update_available || busy || (payload?.git_repo && payload?.channel_exists === false);
    dom.triggerNodeUpdateButton.textContent = busy ? "更新进行中" : "立即更新";
  }

  if (dom.triggerAllNodeUpdatesButton) {
    const hasRemoteNodes = state.servers.some((item) => !item.is_local && item.enabled);
    dom.triggerAllNodeUpdatesButton.disabled = !hasRemoteNodes;
  }

  if (!dom.nodeUpdateStatusEl) {
    return;
  }

  setInnerHTML(dom.nodeUpdateStatusEl, buildUpdateStatusMarkup(payload));
}

export async function loadUpdateStatus() {
  const channel = state.updateChannelOverride;
  const query = channel ? `?channel=${encodeURIComponent(channel)}` : "";
  const payload = await request(`/api/update/status${query}`);
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
    dom.wireguardBootstrapStatusEl.textContent = "可复制到目标主机执行。";

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
    setUpdatePlaceholder(normalizeFeatureError(results[4].reason, "自动更新"));
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
        update_channel: dom.configUpdateChannelInput?.value || "main",
        agent_token: nextAgentToken,
        allow_public_ip: dom.configAllowPublicInput.checked,
        certbot_email: dom.configCertbotEmailInput.value.trim(),
        allow_self_restart: dom.configAllowRestartInput.checked,
      }),
    });
    renderConfig(payload.config);
    state.updateChannelOverride = payload.config?.update_channel || state.updateChannelOverride;
    await loadAccess().catch(() => {});
    await loadUpdateStatus().catch(() => {});
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
    channel: selectedUpdateChannel(),
    mode: dom.nodeUpdateModeInput?.value || "quick",
    pull_latest: Boolean(dom.nodeUpdatePullLatestInput?.checked),
  };

  try {
    const response = await request("/api/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.updateChannelOverride = response.status?.channel || payload.channel;
    renderUpdateStatus(response.status);
    showStatus(
      `已为${currentUpdateTargetLabel()}安排${updateModeLabel(payload.mode)}，通道 ${payload.channel}`,
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
    showStatus(translateUpdateMessage(error.message), "error");
  }
}

export async function triggerAllNodeUpdates() {
  const enabledRemoteNodes = state.servers.filter((item) => !item.is_local && item.enabled);
  if (!enabledRemoteNodes.length) {
    showStatus("没有可更新的远程 Agent 节点", "error");
    return;
  }

  if (
    !window.confirm(
      `确认对 ${enabledRemoteNodes.length} 个远程 Agent 节点执行${updateModeLabel(
        dom.nodeUpdateModeInput?.value || "quick"
      )}吗？当前管理机不会包含在这次批量更新中。`
    )
  ) {
    return;
  }

  const payload = {
    channel: selectedUpdateChannel(),
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

    const summary = `已安排 ${response.scheduled_nodes}/${response.total_nodes} 个 Agent 节点更新`;
    const firstFailure = Array.isArray(response.results)
      ? response.results.find((item) => !item.scheduled)
      : null;
    showStatus(
      firstFailure
        ? `${summary}；${firstFailure.server_name}：${translateUpdateMessage(firstFailure.message)}`
        : `${summary}；方式：${updateModeLabel(response.mode)} · 通道：${payload.channel}`,
      firstFailure ? "info" : "success",
      { autoClearMs: 10000 }
    );
  } catch (error) {
    showStatus(translateUpdateMessage(error.message), "error");
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
