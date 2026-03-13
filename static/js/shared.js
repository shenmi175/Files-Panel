export const TOKEN_STORAGE_KEY = "files_agent_token";

export const state = {
  agent: null,
  access: null,
  config: null,
  authEnabled: false,
  selectedEntry: null,
  currentPath: "/",
  parentPath: null,
  showHidden: false,
  activeView: "dashboard",
  activeDashboardPanel: "resources",
  filesLoaded: false,
  docker: null,
  logsLoaded: false,
  logsCursor: null,
  logLines: [],
  logLevel: "info",
};

export const dom = {
  agentNameEl: document.getElementById("agent-name"),
  agentHostnameEl: document.getElementById("agent-hostname"),
  agentUserEl: document.getElementById("agent-user"),
  agentEntryEl: document.getElementById("agent-entry"),
  agentAuthEl: document.getElementById("agent-auth"),
  authPanel: document.getElementById("auth-panel"),
  tokenInput: document.getElementById("token-input"),
  saveTokenButton: document.getElementById("save-token"),
  clearTokenButton: document.getElementById("clear-token"),
  refreshButton: document.getElementById("refresh-dashboard"),
  resourcesEl: document.getElementById("resources"),
  resourceBreakdownsEl: document.getElementById("resource-breakdowns"),
  chartRangeEl: document.getElementById("chart-range"),
  chartCaptionEl: document.getElementById("chart-caption"),
  chartLegendEl: document.getElementById("chart-legend"),
  resourceChartEl: document.getElementById("resource-chart"),
  accessSummaryEl: document.getElementById("access-summary"),
  accessCardsEl: document.getElementById("access-cards"),
  configSummaryEl: document.getElementById("config-summary"),
  domainForm: document.getElementById("domain-form"),
  domainInput: document.getElementById("domain-input"),
  configForm: document.getElementById("config-form"),
  configAgentNameInput: document.getElementById("config-agent-name"),
  configAgentRootInput: document.getElementById("config-agent-root"),
  configPortInput: document.getElementById("config-port"),
  configCertbotEmailInput: document.getElementById("config-certbot-email"),
  configAllowPublicInput: document.getElementById("config-allow-public"),
  configAllowRestartInput: document.getElementById("config-allow-restart"),
  filesEl: document.getElementById("files"),
  activePathLabel: document.getElementById("active-path"),
  pathBreadcrumbsEl: document.getElementById("path-breadcrumbs"),
  pathInput: document.getElementById("path-input"),
  loadFilesButton: document.getElementById("load-files"),
  goUpButton: document.getElementById("go-up"),
  showHiddenToggle: document.getElementById("show-hidden-toggle"),
  statusEl: document.getElementById("status"),
  uploadInput: document.getElementById("upload-input"),
  uploadButton: document.getElementById("upload-button"),
  filePickerLabel: document.querySelector(".file-picker span"),
  createDirButton: document.getElementById("create-dir-button"),
  renameButton: document.getElementById("rename-button"),
  deleteButton: document.getElementById("delete-button"),
  downloadButton: document.getElementById("download-button"),
  dashboardView: document.getElementById("dashboard-view"),
  settingsView: document.getElementById("settings-view"),
  logsView: document.getElementById("logs-view"),
  resourcePanel: document.getElementById("resource-panel"),
  filesPanel: document.getElementById("files-panel"),
  dashboardPanelTabs: document.querySelectorAll(".dashboard-panel-tab"),
  logsRefreshButton: document.getElementById("refresh-logs"),
  logsServiceEl: document.getElementById("logs-service"),
  logsSummaryEl: document.getElementById("logs-summary"),
  logsCursorEl: document.getElementById("logs-cursor"),
  logsOutputEl: document.getElementById("logs-output"),
  logLevelTabs: document.querySelectorAll(".log-level-tab"),
  viewTabs: document.querySelectorAll(".view-tab"),
};

export function escapeHtml(value) {
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

export function getToken() {
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

export function formatError(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload?.detail)) {
    return payload.detail.map((item) => item.msg).join("; ");
  }
  return payload?.detail || payload?.error || "request failed";
}

export function normalizeFeatureError(error, featureName) {
  if (error?.message !== "Not Found") {
    return error?.message || `${featureName} 加载失败`;
  }
  return `${featureName} 接口未找到。当前运行中的 agent 还是旧版本，请执行 systemctl restart files-agent 后再刷新页面。`;
}

export async function request(path, options = {}) {
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

export function showStatus(message, type = "info") {
  dom.statusEl.textContent = message;
  dom.statusEl.className = `status ${type}`;
}

export function clearStatus() {
  dom.statusEl.textContent = "";
  dom.statusEl.className = "status hidden";
}

export function formatPercent(value) {
  return `${Number(value).toFixed(0)}%`;
}

export function metricCard({ label, value, note, meter = null, tone = "" }) {
  const meterWidth =
    meter === null ? null : meter <= 0 ? 0 : Math.max(4, Math.min(100, meter));
  return `
    <div class="metric-card ${tone}">
      <div class="metric-body">
        <div class="metric-copy">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </div>
        ${
          meterWidth === null
            ? ""
            : `
              <div class="metric-ring" style="--percent:${meterWidth}">
                <span>${escapeHtml(formatPercent(meter))}</span>
              </div>
            `
        }
      </div>
    </div>
  `;
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
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

export function formatRate(value) {
  return `${formatBytes(value)}/s`;
}

export function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

export function formatTimestamp(epoch) {
  return new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false });
}

export function formatShortTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function joinPath(basePath, nextName) {
  const normalizedBase = basePath === "/" ? "/" : basePath.replace(/\/$/, "");
  return normalizedBase === "/" ? `/${nextName}` : `${normalizedBase}/${nextName}`;
}

export function fileTypeLabel(type) {
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

export function fileTypeGlyph(type) {
  switch (type) {
    case "directory":
      return "[DIR]";
    case "symlink":
      return "[LNK]";
    default:
      return "[FIL]";
  }
}

export function getViewFromHash() {
  if (window.location.hash === "#settings") {
    return "settings";
  }
  if (window.location.hash === "#logs") {
    return "logs";
  }
  return "dashboard";
}

export function setView(view) {
  state.activeView = view;
  dom.dashboardView.classList.toggle("hidden", view !== "dashboard");
  dom.settingsView.classList.toggle("hidden", view !== "settings");
  dom.logsView.classList.toggle("hidden", view !== "logs");
  dom.viewTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  const nextHash =
    view === "settings" ? "#settings" : view === "logs" ? "#logs" : "#dashboard";
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, "", nextHash);
  }
}

export function setDashboardPanel(panel) {
  state.activeDashboardPanel = panel;
  dom.resourcePanel.classList.toggle("hidden", panel !== "resources");
  dom.filesPanel.classList.toggle("hidden", panel !== "files");
  dom.dashboardPanelTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.panel === panel);
  });
}

export function updateHeroAccess() {
  if (!state.access) {
    dom.agentEntryEl.textContent = state.authEnabled && !getToken() ? "等待令牌" : "等待接入状态";
    dom.agentAuthEl.textContent = state.authEnabled
      ? getToken()
        ? "Bearer Token 已启用"
        : "需要 Bearer Token"
      : "未启用访问令牌";
    return;
  }

  if (state.access.public_url) {
    dom.agentEntryEl.textContent = state.access.public_url.replace(/^https?:\/\//, "");
    dom.agentAuthEl.textContent = state.access.https_enabled
      ? "域名入口已启用 HTTPS"
      : "域名已接入，HTTPS 申请中";
    return;
  }

  if (state.access.public_ip_access_enabled) {
    dom.agentEntryEl.textContent = `IP:${state.access.desired_bind_port}`;
    dom.agentAuthEl.textContent = state.authEnabled
      ? getToken()
        ? "临时 IP 入口 + Bearer Token"
        : "临时 IP 入口，需 Bearer Token"
      : "当前允许通过 IP:端口 访问";
    return;
  }

  dom.agentEntryEl.textContent = "仅本地监听";
  dom.agentAuthEl.textContent = state.authEnabled
    ? getToken()
      ? "仅本地访问，Bearer Token 已启用"
      : "仅本地访问，需 Bearer Token"
    : "仅本地访问";
}

export function syncAuthPanel(forceVisible = false) {
  const visible = state.authEnabled && (forceVisible || !getToken());
  dom.authPanel.classList.toggle("hidden", !visible);
  updateHeroAccess();
}

export function setResourcesPlaceholder(message) {
  dom.resourcesEl.className = "metric-grid empty";
  dom.resourcesEl.textContent = message;
  dom.resourceBreakdownsEl.className = "resource-detail-grid empty";
  dom.resourceBreakdownsEl.textContent = message;
}

export function setChartPlaceholder(message) {
  dom.chartRangeEl.textContent = "等待数据";
  dom.chartCaptionEl.textContent = message;
  dom.chartLegendEl.innerHTML = "";
  dom.resourceChartEl.className = "chart empty";
  dom.resourceChartEl.textContent = message;
}

export function setFilesPlaceholder(message) {
  dom.filesEl.className = "file-list empty";
  dom.filesEl.textContent = message;
  dom.pathBreadcrumbsEl.innerHTML = "";
}

export function setLogsPlaceholder(message) {
  dom.logsServiceEl.textContent = "等待数据";
  dom.logsSummaryEl.textContent = message;
  dom.logsCursorEl.textContent = "游标未建立";
  dom.logsOutputEl.className = "log-stream empty";
  dom.logsOutputEl.textContent = message;
}

export function setLogLevel(level) {
  state.logLevel = level;
  dom.logLevelTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.level === level);
  });
}

export function setAccessPlaceholder(message) {
  dom.accessCardsEl.className = "metric-grid empty";
  dom.accessCardsEl.textContent = message;
  dom.accessSummaryEl.textContent = message;
  updateHeroAccess();
}

export function setConfigPlaceholder(message) {
  dom.configSummaryEl.className = "metric-grid empty";
  dom.configSummaryEl.textContent = message;
}

export function clearProtectedViews(message) {
  setResourcesPlaceholder(message);
  setChartPlaceholder(message);
  setFilesPlaceholder(message);
  setAccessPlaceholder(message);
  setConfigPlaceholder(message);
  setLogsPlaceholder(message);
}
