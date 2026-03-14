const LEGACY_TOKEN_STORAGE_KEY = "files_agent_token";

const VIEW_HASHES = {
  overview: "#overview",
  files: "#files",
  access: "#access",
  nodes: "#nodes",
  logs: "#logs",
};

let statusClearHandle = 0;

export const state = {
  agent: null,
  access: null,
  config: null,
  authEnabled: false,
  isAuthenticated: false,
  selectedEntry: null,
  currentPath: "/",
  parentPath: null,
  showHidden: false,
  resourceSampleInterval: 5,
  resourceRange: "1h",
  activeView: "overview",
  resourcesLoaded: false,
  filesLoaded: false,
  docker: null,
  accessLoaded: false,
  configLoaded: false,
  serversLoaded: false,
  logsLoaded: false,
  logsCursor: null,
  logLines: [],
  logLevel: "info",
  servers: [],
  preloadStarted: false,
};

export const dom = {
  appShell: document.getElementById("app-shell"),
  loginView: document.getElementById("login-view"),
  loginForm: document.getElementById("login-form"),
  loginTokenInput: document.getElementById("login-token"),
  loginMessageEl: document.getElementById("login-message"),
  logoutButton: document.getElementById("logout-button"),
  agentNameEl: document.getElementById("agent-name"),
  agentHostnameEl: document.getElementById("agent-hostname"),
  agentUserEl: document.getElementById("agent-user"),
  agentEntryEl: document.getElementById("agent-entry"),
  agentAuthEl: document.getElementById("agent-auth"),
  refreshButton: document.getElementById("refresh-dashboard"),
  resourcesEl: document.getElementById("resources"),
  resourceBreakdownsEl: document.getElementById("resource-breakdowns"),
  chartRangeEl: document.getElementById("chart-range"),
  chartCaptionEl: document.getElementById("chart-caption"),
  chartLegendEl: document.getElementById("chart-legend"),
  resourceRangeTabsEl: document.getElementById("resource-range-tabs"),
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
  configSampleIntervalInput: document.getElementById("config-sample-interval"),
  configAgentTokenInput: document.getElementById("config-agent-token"),
  configResetTokenButton: document.getElementById("config-reset-token"),
  configCertbotEmailInput: document.getElementById("config-certbot-email"),
  configAllowPublicInput: document.getElementById("config-allow-public"),
  configAllowRestartInput: document.getElementById("config-allow-restart"),
  serverForm: document.getElementById("server-form"),
  serverIdInput: document.getElementById("server-id"),
  serverNameInput: document.getElementById("server-name"),
  serverBaseUrlInput: document.getElementById("server-base-url"),
  serverWireguardIpInput: document.getElementById("server-wireguard-ip"),
  serverTokenInput: document.getElementById("server-token"),
  serverEnabledInput: document.getElementById("server-enabled"),
  resetServerFormButton: document.getElementById("reset-server-form"),
  serversSummaryEl: document.getElementById("servers-summary"),
  serversListEl: document.getElementById("servers-list"),
  filesEl: document.getElementById("files"),
  activePathLabel: document.getElementById("active-path"),
  pathBreadcrumbsEl: document.getElementById("path-breadcrumbs"),
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
  overviewView: document.getElementById("overview-view"),
  filesView: document.getElementById("files-view"),
  accessView: document.getElementById("access-view"),
  nodesView: document.getElementById("nodes-view"),
  logsView: document.getElementById("logs-view"),
  logsRefreshButton: document.getElementById("refresh-logs"),
  logsServiceEl: document.getElementById("logs-service"),
  logsSummaryEl: document.getElementById("logs-summary"),
  logsCursorEl: document.getElementById("logs-cursor"),
  logsOutputEl: document.getElementById("logs-output"),
  logLevelTabs: document.querySelectorAll(".log-level-tab"),
  resourceRangeButtons: document.querySelectorAll(".resource-range-tab"),
  viewTabs: document.querySelectorAll(".view-tab"),
};

function normalizeView(value) {
  return Object.prototype.hasOwnProperty.call(VIEW_HASHES, value) ? value : "overview";
}

export function removePersistedToken() {
  window.localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  window.sessionStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
}

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
    return error?.message || `${featureName}加载失败`;
  }
  return `${featureName}接口未找到，请确认已部署最新版本后执行 file-panel restart`;
}

export async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: new Headers(options.headers || {}),
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (response.status === 401) {
    state.isAuthenticated = false;
    window.dispatchEvent(
      new CustomEvent("auth:expired", {
        detail: { message: formatError(payload) || "会话已失效，请重新登录" },
      })
    );
  }

  if (!response.ok) {
    throw new Error(formatError(payload));
  }

  return payload;
}

export function showStatus(message, type = "info", options = {}) {
  if (statusClearHandle) {
    window.clearTimeout(statusClearHandle);
    statusClearHandle = 0;
  }

  dom.statusEl.textContent = message;
  dom.statusEl.className = `status ${type}`;
  const autoClearMs = Number(options?.autoClearMs) || 0;
  if (autoClearMs > 0) {
    statusClearHandle = window.setTimeout(() => {
      clearStatus();
    }, autoClearMs);
  }
}

export function clearStatus() {
  if (statusClearHandle) {
    window.clearTimeout(statusClearHandle);
    statusClearHandle = 0;
  }
  dom.statusEl.textContent = "";
  dom.statusEl.className = "status hidden";
}

export function formatPercent(value) {
  return `${Number(value).toFixed(0)}%`;
}

export function metricCard({ label, value, note, meter = null, meterLabel = null, tone = "", cardClass = "" }) {
  const meterWidth =
    meter === null ? null : meter <= 0 ? 0 : Math.max(4, Math.min(100, meter));
  const cardClasses = [
    "metric-card",
    tone,
    meterWidth === null ? "is-text" : "is-meter",
    cardClass,
  ]
    .filter(Boolean)
    .join(" ");
  return `
    <div class="${cardClasses}">
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
                <span>${escapeHtml(meterLabel ?? formatPercent(meter))}</span>
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
      return "未知";
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
  return normalizeView(window.location.hash.replace(/^#/, ""));
}

export function setView(view) {
  const normalizedView = normalizeView(view);
  state.activeView = normalizedView;
  dom.overviewView.classList.toggle("hidden", normalizedView !== "overview");
  dom.filesView.classList.toggle("hidden", normalizedView !== "files");
  dom.accessView.classList.toggle("hidden", normalizedView !== "access");
  dom.nodesView.classList.toggle("hidden", normalizedView !== "nodes");
  dom.logsView.classList.toggle("hidden", normalizedView !== "logs");
  dom.viewTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === normalizedView);
  });
  const nextHash = VIEW_HASHES[normalizedView];
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, "", nextHash);
  }
}

export function updateHeroAccess() {
  if (!state.isAuthenticated && state.authEnabled) {
    dom.agentEntryEl.textContent = "等待登录";
    dom.agentAuthEl.textContent = "需要会话登录后才会加载节点信息";
    return;
  }

  if (!state.access) {
    dom.agentEntryEl.textContent = "等待接入状态";
    dom.agentAuthEl.textContent = state.authEnabled ? "访问令牌已启用" : "当前未启用令牌";
    return;
  }

  if (state.access.public_url) {
    dom.agentEntryEl.textContent = state.access.public_url.replace(/^https?:\/\//, "");
    dom.agentAuthEl.textContent = state.access.https_enabled
      ? "域名入口已启用 HTTPS"
      : "域名入口已建立，等待 HTTPS 就绪";
    return;
  }

  if (state.access.public_ip_access_enabled) {
    dom.agentEntryEl.textContent = `IP:${state.access.desired_bind_port}`;
    dom.agentAuthEl.textContent = state.authEnabled
      ? "通过登录会话访问公开入口"
      : "当前允许通过 IP:端口 访问";
    return;
  }

  dom.agentEntryEl.textContent = "等待接入状态";
  dom.agentAuthEl.textContent = state.authEnabled
    ? "访问令牌已启用"
    : "当前未启用令牌";
}

export function setResourcesPlaceholder(message) {
  dom.resourcesEl.className = "metric-grid empty";
  dom.resourcesEl.textContent = message;
  dom.resourceBreakdownsEl.className = "resource-detail-grid empty";
  dom.resourceBreakdownsEl.textContent = message;
}

export function setChartPlaceholder(message) {
  dom.chartRangeEl.textContent = "等待采样";
  dom.chartCaptionEl.textContent = message;
  dom.chartLegendEl.innerHTML = "";
  dom.resourceChartEl.className = "chart empty";
  dom.resourceChartEl.textContent = message;
}

export function setFilesPlaceholder(message) {
  dom.filesEl.className = "file-list empty";
  dom.filesEl.textContent = message;
  dom.pathBreadcrumbsEl.innerHTML = "";
  dom.activePathLabel.textContent = message;
}

export function setLogsPlaceholder(message) {
  dom.logsServiceEl.textContent = "等待日志";
  dom.logsSummaryEl.textContent = message;
  dom.logsCursorEl.textContent = "尚未建立游标";
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

export function setServersPlaceholder(message) {
  dom.serversSummaryEl.textContent = message;
  dom.serversListEl.className = "server-list empty";
  dom.serversListEl.textContent = message;
}

export function clearProtectedViews(message) {
  setResourcesPlaceholder(message);
  setChartPlaceholder(message);
  setFilesPlaceholder(message);
  setAccessPlaceholder(message);
  setConfigPlaceholder(message);
  setServersPlaceholder(message);
  setLogsPlaceholder(message);
}
