const TOKEN_STORAGE_KEY = "files_agent_token";
const CHART_SERIES = [
  { key: "memory_used_percent", label: "内存", color: "#1d5c4d" },
  { key: "disk_used_percent", label: "磁盘", color: "#c57a38" },
  { key: "load_ratio_percent", label: "负载", color: "#6a7b54" },
];

const state = {
  agent: null,
  access: null,
  config: null,
  authEnabled: false,
  selectedEntry: null,
  currentPath: "/",
  parentPath: null,
  showHidden: false,
  activeView: "dashboard",
};

const agentNameEl = document.getElementById("agent-name");
const agentHostnameEl = document.getElementById("agent-hostname");
const agentUserEl = document.getElementById("agent-user");
const agentEntryEl = document.getElementById("agent-entry");
const agentAuthEl = document.getElementById("agent-auth");
const authPanel = document.getElementById("auth-panel");
const tokenInput = document.getElementById("token-input");
const saveTokenButton = document.getElementById("save-token");
const clearTokenButton = document.getElementById("clear-token");
const refreshButton = document.getElementById("refresh-dashboard");
const resourcesEl = document.getElementById("resources");
const chartRangeEl = document.getElementById("chart-range");
const chartCaptionEl = document.getElementById("chart-caption");
const chartLegendEl = document.getElementById("chart-legend");
const resourceChartEl = document.getElementById("resource-chart");
const accessSummaryEl = document.getElementById("access-summary");
const accessCardsEl = document.getElementById("access-cards");
const configSummaryEl = document.getElementById("config-summary");
const domainForm = document.getElementById("domain-form");
const domainInput = document.getElementById("domain-input");
const configForm = document.getElementById("config-form");
const configAgentNameInput = document.getElementById("config-agent-name");
const configAgentRootInput = document.getElementById("config-agent-root");
const configPortInput = document.getElementById("config-port");
const configCertbotEmailInput = document.getElementById("config-certbot-email");
const configAllowPublicInput = document.getElementById("config-allow-public");
const configAllowRestartInput = document.getElementById("config-allow-restart");
const filesEl = document.getElementById("files");
const activePathLabel = document.getElementById("active-path");
const pathBreadcrumbsEl = document.getElementById("path-breadcrumbs");
const pathInput = document.getElementById("path-input");
const loadFilesButton = document.getElementById("load-files");
const goUpButton = document.getElementById("go-up");
const showHiddenToggle = document.getElementById("show-hidden-toggle");
const statusEl = document.getElementById("status");
const uploadInput = document.getElementById("upload-input");
const uploadButton = document.getElementById("upload-button");
const filePickerLabel = document.querySelector(".file-picker span");
const createDirButton = document.getElementById("create-dir-button");
const renameButton = document.getElementById("rename-button");
const deleteButton = document.getElementById("delete-button");
const downloadButton = document.getElementById("download-button");
const dashboardView = document.getElementById("dashboard-view");
const settingsView = document.getElementById("settings-view");
const viewTabs = document.querySelectorAll(".view-tab");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function getToken() {
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

function formatError(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload?.detail)) {
    return payload.detail.map((item) => item.msg).join("; ");
  }
  return payload?.detail || payload?.error || "request failed";
}

function normalizeFeatureError(error, featureName) {
  if (error?.message !== "Not Found") {
    return error?.message || `${featureName} 加载失败`;
  }
  return `${featureName} 接口未找到。当前运行中的 agent 还是旧版本，请执行 systemctl restart files-agent 后再刷新页面。`;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (response.status === 401) {
    syncAuthPanel(true);
  }

  if (!response.ok) {
    throw new Error(formatError(payload));
  }

  return payload;
}

function showStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status hidden";
}

function metricCard({ label, value, note, meter = null, tone = "" }) {
  const meterWidth =
    meter === null ? null : meter <= 0 ? 0 : Math.max(4, Math.min(100, meter));
  return `
    <div class="metric-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
      ${meterWidth === null ? "" : `<div class="meter"><i style="width:${meterWidth}%"></i></div>`}
    </div>
  `;
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatTimestamp(epoch) {
  return new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false });
}

function formatShortTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPercent(value) {
  return `${Number(value).toFixed(0)}%`;
}

function joinPath(basePath, nextName) {
  const normalizedBase = basePath === "/" ? "/" : basePath.replace(/\/$/, "");
  return normalizedBase === "/" ? `/${nextName}` : `${normalizedBase}/${nextName}`;
}

function navigateToPath(targetPath) {
  pathInput.value = targetPath;
  return loadFiles();
}

function fileTypeLabel(type) {
  switch (type) {
    case "directory":
      return "目录";
    case "symlink":
      return "链接";
    case "file":
      return "文件";
    default:
      return "其他";
  }
}

function fileTypeGlyph(type) {
  switch (type) {
    case "directory":
      return "[DIR]";
    case "symlink":
      return "[LNK]";
    default:
      return "[FIL]";
  }
}

function buildFilesUrl(targetPath) {
  const params = new URLSearchParams();
  params.set("path", targetPath || "/");
  if (state.showHidden) {
    params.set("show_hidden", "true");
  }
  return `/api/files?${params.toString()}`;
}

function getViewFromHash() {
  return window.location.hash === "#settings" ? "settings" : "dashboard";
}

function setView(view) {
  state.activeView = view;
  dashboardView.classList.toggle("hidden", view !== "dashboard");
  settingsView.classList.toggle("hidden", view !== "settings");
  viewTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  const nextHash = view === "settings" ? "#settings" : "#dashboard";
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, "", nextHash);
  }
}

function syncAuthPanel(forceVisible = false) {
  const visible = state.authEnabled && (forceVisible || !getToken());
  authPanel.classList.toggle("hidden", !visible);
  updateHeroAccess();
}

function updateHeroAccess() {
  if (!state.access) {
    agentEntryEl.textContent = state.authEnabled && !getToken() ? "等待令牌" : "等待接入状态";
    agentAuthEl.textContent = state.authEnabled
      ? getToken()
        ? "Bearer Token 已启用"
        : "需要 Bearer Token"
      : "未启用访问令牌";
    return;
  }

  if (state.access.public_url) {
    agentEntryEl.textContent = state.access.public_url.replace(/^https?:\/\//, "");
    agentAuthEl.textContent = state.access.https_enabled
      ? "域名入口已启用 HTTPS"
      : "域名已接入，HTTPS 申请中";
    return;
  }

  if (state.access.public_ip_access_enabled) {
    agentEntryEl.textContent = `IP:${state.access.desired_bind_port}`;
    agentAuthEl.textContent = state.authEnabled
      ? getToken()
        ? "临时 IP 入口 + Bearer Token"
        : "临时 IP 入口，需 Bearer Token"
      : "当前允许通过 IP:端口 访问";
    return;
  }

  agentEntryEl.textContent = "仅本地监听";
  agentAuthEl.textContent = state.authEnabled
    ? getToken()
      ? "仅本地访问，Bearer Token 已启用"
      : "仅本地访问，需 Bearer Token"
    : "仅本地访问";
}

function setResourcesPlaceholder(message) {
  resourcesEl.className = "metric-grid empty";
  resourcesEl.textContent = message;
}

function setChartPlaceholder(message) {
  chartRangeEl.textContent = "等待数据";
  chartCaptionEl.textContent = message;
  chartLegendEl.innerHTML = "";
  resourceChartEl.className = "chart empty";
  resourceChartEl.textContent = message;
}

function setFilesPlaceholder(message) {
  filesEl.className = "file-list empty";
  filesEl.textContent = message;
  pathBreadcrumbsEl.innerHTML = "";
}

function setAccessPlaceholder(message) {
  accessCardsEl.className = "metric-grid empty";
  accessCardsEl.textContent = message;
  accessSummaryEl.textContent = message;
  updateHeroAccess();
}

function setConfigPlaceholder(message) {
  configSummaryEl.className = "metric-grid empty";
  configSummaryEl.textContent = message;
}

async function loadHealth() {
  const response = await fetch("/api/health");
  const payload = await response.json();
  state.authEnabled = Boolean(payload.auth_enabled);
  syncAuthPanel(false);
}

async function loadAgent() {
  const agent = await request("/api/agent");
  state.agent = agent;
  state.currentPath = agent.root_path;
  state.parentPath = null;
  pathInput.value = agent.root_path;
  activePathLabel.textContent = agent.root_path;
  agentNameEl.textContent = agent.agent_name;
  agentHostnameEl.textContent = agent.hostname;
  agentUserEl.textContent = agent.current_user;
  syncAuthPanel(false);
}

function renderResources(snapshot) {
  const cpuCount = Number.isFinite(Number(snapshot.cpu_count)) ? Number(snapshot.cpu_count) : null;
  const loadRatioPercent = Number.isFinite(Number(snapshot.load_ratio_percent))
    ? Number(snapshot.load_ratio_percent)
    : null;
  const memoryUsedPercent = Number.isFinite(snapshot.memory?.used_percent)
    ? snapshot.memory.used_percent
    : snapshot.memory?.total_mb
      ? (snapshot.memory.used_mb / snapshot.memory.total_mb) * 100
      : null;
  const diskPercentValue =
    typeof snapshot.root_disk?.used_percent === "string"
      ? parseFloat(snapshot.root_disk.used_percent)
      : snapshot.root_disk?.used_percent;
  const diskUsedPercent = Number.isFinite(diskPercentValue) ? Number(diskPercentValue) : null;
  resourcesEl.className = "metric-grid";
  resourcesEl.innerHTML = [
    metricCard({
      label: "主机与运行时",
      value: snapshot.hostname,
      note: `${snapshot.uptime} · ${cpuCount ? `${cpuCount} vCPU` : "重启 agent 后显示 CPU 信息"}`,
      tone: "tone-accent",
    }),
    metricCard({
      label: "Load",
      value: `${snapshot.load_average.one.toFixed(2)} / ${snapshot.load_average.five.toFixed(2)} / ${snapshot.load_average.fifteen.toFixed(2)}`,
      note:
        loadRatioPercent === null
          ? "1m / 5m / 15m，占比需重启 agent 后显示"
          : `1m / 5m / 15m，当前约 ${formatPercent(loadRatioPercent)}`,
      meter: loadRatioPercent,
      tone: "tone-olive",
    }),
    metricCard({
      label: "内存",
      value: `${snapshot.memory.used_mb} / ${snapshot.memory.total_mb} MB`,
      note: `available ${snapshot.memory.available_mb} MB`,
      meter: memoryUsedPercent,
      tone: "tone-green",
    }),
    metricCard({
      label: "磁盘",
      value: `${snapshot.root_disk.used} / ${snapshot.root_disk.total}`,
      note:
        diskUsedPercent === null
          ? `${snapshot.root_disk.mount_point} · 占比待刷新`
          : `${snapshot.root_disk.mount_point} · ${formatPercent(diskUsedPercent)}`,
      meter: diskUsedPercent,
      tone: "tone-amber",
    }),
  ].join("");
}

function renderResourceChart(payload) {
  const points = payload.points || [];
  chartLegendEl.innerHTML = CHART_SERIES.map(
    (series) => `
      <span class="legend-chip">
        <i style="background:${series.color}"></i>
        ${escapeHtml(series.label)}
      </span>
    `
  ).join("");

  if (!points.length) {
    setChartPlaceholder("暂无趋势数据");
    return;
  }

  const width = 960;
  const height = 280;
  const padding = { top: 18, right: 16, bottom: 32, left: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index) =>
    points.length === 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (points.length - 1)) * plotWidth;
  const y = (value) =>
    padding.top + ((100 - Math.max(0, Math.min(100, value))) / 100) * plotHeight;

  const gridValues = [0, 25, 50, 75, 100];
  const grid = gridValues
    .map(
      (value) => `
        <line x1="${padding.left}" y1="${y(value)}" x2="${width - padding.right}" y2="${y(value)}" />
        <text x="2" y="${y(value) + 4}">${value}%</text>
      `
    )
    .join("");

  const lines = CHART_SERIES.map((series) => {
    const polylinePoints = points
      .map((point, index) => `${x(index)},${y(point[series.key])}`)
      .join(" ");
    const lastPoint = points[points.length - 1];
    return `
      <polyline fill="none" stroke="${series.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polylinePoints}" />
      <circle cx="${x(points.length - 1)}" cy="${y(lastPoint[series.key])}" r="4.5" fill="${series.color}" />
    `;
  }).join("");

  const startLabel = formatShortTime(points[0].timestamp);
  const endLabel = formatShortTime(points[points.length - 1].timestamp);
  chartRangeEl.textContent = `最近 ${points.length} 个采样点 · 每 ${payload.interval_seconds} 秒`;
  chartCaptionEl.textContent = `${startLabel} - ${endLabel}`;
  resourceChartEl.className = "chart";
  resourceChartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="资源趋势图">
      <g class="chart-grid">${grid}</g>
      <g class="chart-lines">${lines}</g>
      <text class="chart-axis" x="${padding.left}" y="${height - 8}">${escapeHtml(startLabel)}</text>
      <text class="chart-axis" x="${width - padding.right}" y="${height - 8}" text-anchor="end">${escapeHtml(endLabel)}</text>
    </svg>
  `;
}

function renderAccess(payload) {
  state.access = payload;
  updateHeroAccess();

  if (payload.public_url) {
    accessSummaryEl.textContent = payload.restart_pending
      ? `域名已接入：${payload.public_url}，等待 agent 切回本地监听`
      : `域名已接入：${payload.public_url}`;
  } else if (payload.public_ip_access_enabled) {
    accessSummaryEl.textContent = `当前临时开放 IP:${payload.desired_bind_port} 访问`;
  } else {
    accessSummaryEl.textContent = "当前只接受本地访问";
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

  accessCardsEl.className = "metric-grid";
  accessCardsEl.innerHTML = [
    metricCard({
      label: "当前监听",
      value: `${payload.current_bind_host}:${payload.current_bind_port}`,
      note: payload.restart_pending ? "重启后会切换到新的监听地址" : "当前生效",
      tone: "tone-accent",
    }),
    metricCard({
      label: "目标监听",
      value: `${payload.desired_bind_host}:${payload.desired_bind_port}`,
      note: payload.public_ip_access_enabled ? "仍允许通过 IP 访问" : "域名完成后只保留本地监听",
      tone: "tone-green",
    }),
    metricCard({
      label: "对外入口",
      value: publicEntry,
      note: payload.token_configured ? "Bearer Token 已配置" : "未配置访问令牌",
      tone: "tone-amber",
    }),
    metricCard({
      label: "Nginx / Certbot",
      value: nginxStatus,
      note: payload.https_enabled
        ? "HTTPS 已就绪"
        : payload.certbot_available
          ? "证书将在域名接入时申请"
          : "未检测到 certbot",
      tone: "tone-olive",
    }),
  ].join("");
}

function renderConfig(config) {
  state.config = config;
  configAgentNameInput.value = config.agent_name;
  configAgentRootInput.value = config.agent_root;
  configPortInput.value = String(config.port);
  configCertbotEmailInput.value = config.certbot_email || "";
  configAllowPublicInput.checked = config.allow_public_ip;
  configAllowRestartInput.checked = config.allow_self_restart;

  configSummaryEl.className = "metric-grid";
  configSummaryEl.innerHTML = [
    metricCard({
      label: "固定根目录",
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
      value: config.public_domain || "未接入域名",
      note: config.restart_pending ? "存在待重启生效的参数" : "当前环境文件已同步",
      tone: "tone-amber",
    }),
    metricCard({
      label: "鉴权 / 证书",
      value: config.token_configured ? "Bearer Token 已配置" : "未配置 Token",
      note: config.certbot_email || "未设置 Certbot 邮箱",
      tone: "tone-olive",
    }),
  ].join("");
}

function buildBreadcrumbs(currentPath, rootPath) {
  const root = rootPath || "/";
  const crumbs = [];
  const rootLabel =
    root === "/" ? "/" : root.split("/").filter(Boolean).slice(-1)[0] || root;
  crumbs.push({ label: rootLabel, path: root });

  if (currentPath === root) {
    return crumbs;
  }

  const relative = currentPath.startsWith(root)
    ? currentPath.slice(root.length).replace(/^\/+/, "")
    : currentPath.replace(/^\/+/, "");
  const parts = relative ? relative.split("/").filter(Boolean) : [];
  let cursor = root === "/" ? "" : root;
  parts.forEach((part) => {
    cursor = cursor === "/" || cursor === "" ? `/${part}` : `${cursor}/${part}`;
    crumbs.push({ label: part, path: cursor });
  });
  return crumbs;
}

function renderBreadcrumbs(currentPath, rootPath) {
  const crumbs = buildBreadcrumbs(currentPath, rootPath);
  pathBreadcrumbsEl.innerHTML = crumbs
    .map(
      (crumb, index) => `
        <button
          class="crumb ${index === crumbs.length - 1 ? "is-current" : ""}"
          type="button"
          data-path="${escapeHtml(crumb.path)}"
        >
          ${escapeHtml(crumb.label)}
        </button>
      `
    )
    .join('<span class="crumb-sep">/</span>');

  pathBreadcrumbsEl.querySelectorAll(".crumb").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.classList.contains("is-current")) {
        return;
      }
      state.selectedEntry = null;
      await navigateToPath(button.dataset.path);
    });
  });
}

function renderFiles(payload) {
  state.currentPath = payload.current_path;
  state.parentPath = payload.parent_path;
  state.showHidden = payload.show_hidden;
  pathInput.value = payload.current_path;
  showHiddenToggle.checked = payload.show_hidden;
  activePathLabel.textContent = payload.show_hidden
    ? `${payload.current_path} · 已显示隐藏文件`
    : `${payload.current_path} · 默认隐藏点文件`;
  renderBreadcrumbs(payload.current_path, payload.root_path);

  if (state.selectedEntry && !payload.entries.some((entry) => entry.path === state.selectedEntry.path)) {
    state.selectedEntry = null;
  }

  if (!payload.entries.length) {
    setFilesPlaceholder(payload.show_hidden ? "目录为空" : "目录为空，或当前只有隐藏文件");
    return;
  }

  filesEl.className = "file-list";
  filesEl.innerHTML = payload.entries
    .map((entry) => {
      const selected = state.selectedEntry?.path === entry.path ? "selected" : "";
      return `
        <div class="file-row ${selected}" data-path="${escapeHtml(entry.path)}" data-type="${escapeHtml(entry.file_type)}" data-name="${escapeHtml(entry.name)}">
          <div class="file-main">
            <button
              type="button"
              class="entry-link ${entry.file_type === "directory" ? "is-directory" : ""}"
              data-path="${escapeHtml(entry.path)}"
              data-type="${escapeHtml(entry.file_type)}"
              data-name="${escapeHtml(entry.name)}"
            >
              <span class="entry-glyph">${fileTypeGlyph(entry.file_type)}</span>
              <strong>${escapeHtml(entry.name)}</strong>
            </button>
            <small>${escapeHtml(entry.mode)} · ${escapeHtml(formatTimestamp(entry.modified_epoch))}</small>
          </div>
          <span class="file-pill">${escapeHtml(fileTypeLabel(entry.file_type))}</span>
          <span>${escapeHtml(formatBytes(entry.size))}</span>
          <span class="path-cell">${escapeHtml(entry.path)}</span>
        </div>
      `;
    })
    .join("");

  filesEl.querySelectorAll(".file-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedEntry = {
        path: row.dataset.path,
        type: row.dataset.type,
        name: row.dataset.name,
      };
      renderFiles(payload);
    });

    row.addEventListener("dblclick", async () => {
      if (row.dataset.type === "directory") {
        state.selectedEntry = null;
        await navigateToPath(row.dataset.path);
      }
    });
  });
}

async function loadResourcesSection() {
  const [snapshotResult, historyResult] = await Promise.allSettled([
    request("/api/resources"),
    request("/api/resources/history"),
  ]);

  if (snapshotResult.status === "fulfilled") {
    renderResources(snapshotResult.value);
  } else {
    setResourcesPlaceholder(snapshotResult.reason.message);
    throw snapshotResult.reason;
  }

  if (historyResult.status === "fulfilled") {
    renderResourceChart(historyResult.value);
  } else {
    setChartPlaceholder(normalizeFeatureError(historyResult.reason, "资源趋势"));
  }
}

async function loadAccess() {
  const payload = await request("/api/access");
  renderAccess(payload);
}

async function loadConfig() {
  const payload = await request("/api/config");
  renderConfig(payload);
}

async function refreshSettings() {
  const [accessResult, configResult] = await Promise.allSettled([loadAccess(), loadConfig()]);
  if (accessResult.status === "rejected") {
    setAccessPlaceholder(accessResult.reason.message);
    throw accessResult.reason;
  }
  if (configResult.status === "rejected") {
    setConfigPlaceholder(normalizeFeatureError(configResult.reason, "固定参数"));
  }
}

async function loadFiles() {
  const payload = await request(buildFilesUrl(pathInput.value || state.currentPath || "/"));
  renderFiles(payload);
}

async function refreshDashboard({ includeFiles = true } = {}) {
  const tasks = [loadResourcesSection()];
  if (includeFiles) {
    tasks.push(loadFiles());
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
}

async function refreshAll({ includeFiles = true } = {}) {
  clearStatus();
  const results = await Promise.allSettled([
    refreshDashboard({ includeFiles }),
    refreshSettings(),
  ]);
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure?.status === "rejected") {
    showStatus(firstFailure.reason.message, "error");
  }
}

function goUp() {
  if (!state.parentPath) {
    return;
  }
  navigateToPath(state.parentPath).catch((error) => showStatus(error.message, "error"));
}

async function uploadFile() {
  const file = uploadInput.files[0];
  if (!file) {
    showStatus("请选择要上传的文件", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    await request(`/api/files/upload?path=${encodeURIComponent(pathInput.value || state.currentPath || "/")}`, {
      method: "POST",
      body: formData,
    });
    uploadInput.value = "";
    filePickerLabel.textContent = "选择文件";
    showStatus(`已上传 ${file.name}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function createDirectory() {
  const nextName = window.prompt("输入新目录名称");
  if (!nextName) {
    return;
  }

  try {
    await request("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: joinPath(pathInput.value || state.currentPath, nextName),
      }),
    });
    showStatus(`已创建目录 ${nextName}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function renameSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择文件或目录", "error");
    return;
  }

  const nextName = window.prompt("输入新名称", state.selectedEntry.name);
  if (!nextName || nextName === state.selectedEntry.name) {
    return;
  }

  try {
    await request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        old_path: state.selectedEntry.path,
        new_path: joinPath(pathInput.value || state.currentPath, nextName),
      }),
    });
    state.selectedEntry = null;
    showStatus(`已重命名为 ${nextName}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function deleteSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择文件或目录", "error");
    return;
  }

  const confirmed = window.confirm(`确认删除 ${state.selectedEntry.name} ?`);
  if (!confirmed) {
    return;
  }

  try {
    await request(`/api/files?path=${encodeURIComponent(state.selectedEntry.path)}`, {
      method: "DELETE",
    });
    state.selectedEntry = null;
    showStatus(`已删除 ${state.selectedEntry.name}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function downloadSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择文件", "error");
    return;
  }
  if (state.selectedEntry.type !== "file") {
    showStatus("下载只支持普通文件", "error");
    return;
  }

  try {
    const headers = new Headers();
    const token = getToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(
      `/api/files/download?path=${encodeURIComponent(state.selectedEntry.path)}`,
      { headers }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(formatError(payload));
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = state.selectedEntry.name;
    anchor.click();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function configureDomain(event) {
  event.preventDefault();
  const domain = domainInput.value.trim();
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
    domainInput.value = "";
    showStatus(
      payload.restart_scheduled
        ? `域名已接入：${payload.public_url}。agent 将自动切回仅本地监听。`
        : `域名已接入：${payload.public_url}`,
      "success"
    );
    await refreshSettings().catch(() => {});
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function saveConfig(event) {
  event.preventDefault();
  const nextPort = Number(configPortInput.value);
  if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
    showStatus("监听端口必须是 1-65535 之间的整数", "error");
    return;
  }

  try {
    const payload = await request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: configAgentNameInput.value.trim(),
        agent_root: configAgentRootInput.value.trim(),
        port: nextPort,
        allow_public_ip: configAllowPublicInput.checked,
        certbot_email: configCertbotEmailInput.value.trim(),
        allow_self_restart: configAllowRestartInput.checked,
      }),
    });
    renderConfig(payload.config);
    await loadAccess().catch(() => {});
    showStatus(
      payload.restart_scheduled
        ? "固定参数已保存，agent 正在重启应用新参数"
        : payload.restart_required
          ? "固定参数已保存，等待你手动重启 agent 生效"
          : "固定参数已保存",
      payload.restart_required ? "info" : "success"
    );
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function saveToken() {
  const nextToken = tokenInput.value.trim();
  if (!nextToken) {
    showStatus("请输入访问令牌", "error");
    return;
  }

  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
  tokenInput.value = "";
  syncAuthPanel(false);
  try {
    await refreshAll();
    showStatus("访问令牌已生效", "success");
  } catch (error) {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    syncAuthPanel(true);
    showStatus(error.message, "error");
  }
}

function clearProtectedViews(message) {
  setResourcesPlaceholder(message);
  setChartPlaceholder(message);
  setFilesPlaceholder(message);
  setAccessPlaceholder(message);
  setConfigPlaceholder(message);
}

function clearToken() {
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  state.access = null;
  state.config = null;
  state.selectedEntry = null;
  syncAuthPanel(true);
  clearProtectedViews("输入访问令牌后即可继续操作");
  showStatus("已清除当前会话令牌", "info");
}

refreshButton.addEventListener("click", () => refreshAll().catch((error) => showStatus(error.message, "error")));
loadFilesButton.addEventListener("click", () => loadFiles().catch((error) => showStatus(error.message, "error")));
goUpButton.addEventListener("click", goUp);
showHiddenToggle.addEventListener("change", () => {
  state.showHidden = showHiddenToggle.checked;
  state.selectedEntry = null;
  loadFiles().catch((error) => showStatus(error.message, "error"));
});
uploadButton.addEventListener("click", uploadFile);
uploadInput.addEventListener("change", () => {
  filePickerLabel.textContent = uploadInput.files[0]?.name || "选择文件";
});
createDirButton.addEventListener("click", createDirectory);
renameButton.addEventListener("click", renameSelected);
deleteButton.addEventListener("click", deleteSelected);
downloadButton.addEventListener("click", downloadSelected);
saveTokenButton.addEventListener("click", saveToken);
clearTokenButton.addEventListener("click", clearToken);
domainForm.addEventListener("submit", configureDomain);
configForm.addEventListener("submit", saveConfig);
pathInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadFiles().catch((error) => showStatus(error.message, "error"));
  }
});
tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveToken().catch((error) => showStatus(error.message, "error"));
  }
});
viewTabs.forEach((button) => {
  button.addEventListener("click", () => {
    setView(button.dataset.view);
    if (button.dataset.view === "settings" && (!state.access || !state.config)) {
      refreshSettings().catch((error) => showStatus(error.message, "error"));
    }
  });
});
window.addEventListener("hashchange", () => setView(getViewFromHash()));

async function boot() {
  setView(getViewFromHash());
  try {
    await loadHealth();
    await loadAgent();
    if (!state.authEnabled || getToken()) {
      await refreshAll();
    } else {
      clearProtectedViews("输入访问令牌后即可读取本机信息");
    }
  } catch (error) {
    clearProtectedViews("初始化失败");
    showStatus(error.message, "error");
  }
}

boot();
window.setInterval(() => {
  if (!state.authEnabled || getToken()) {
    refreshDashboard({ includeFiles: false }).catch(() => {});
    if (state.activeView === "settings") {
      loadAccess().catch(() => {});
    }
  }
}, 15000);
