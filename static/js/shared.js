const LEGACY_TOKEN_STORAGE_KEY = "files_agent_token";
const SELECTED_SERVER_ID_STORAGE_KEY = "file_panel_selected_server_id";
const SELECTED_SERVER_NAME_STORAGE_KEY = "file_panel_selected_server_name";

const VIEW_HASHES = {
  overview: "#overview",
  guide: "#guide",
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
  registrationRequired: false,
  sessionUsername: null,
  selectedEntry: null,
  selectedServerId: null,
  selectedServerName: null,
  updateChannelOverride: null,
  fileBrowseMode: "workspace",
  fileReadOnly: false,
  systemRoots: [],
  selectedSystemRoot: null,
  currentPath: null,
  parentPath: null,
  showHidden: false,
  resourceSampleInterval: 5,
  resourceRange: "30d",
  activeView: "overview",
  resourcesLoaded: false,
  filesLoaded: false,
  docker: null,
  accessLoaded: false,
  configLoaded: false,
  serversLoaded: false,
  wireguardBootstrapLoaded: false,
  wireguardBootstrapStatus: null,
  updateStatusLoaded: false,
  updateStatus: null,
  logsLoaded: false,
  logsCursor: null,
  logLines: [],
  logLevel: "info",
  servers: [],
  preloadStarted: false,
};

function ensureFileBrowserControls() {
  const filesWorkspace = document.querySelector("#files-view .files-workspace");
  const fileHeader = filesWorkspace?.querySelector(".file-header");
  if (!filesWorkspace || !fileHeader || document.getElementById("file-browse-controls")) {
    return;
  }

  const controls = document.createElement("div");
  controls.id = "file-browse-controls";
  controls.className = "file-browse-controls";
  controls.innerHTML = `
    <div class="file-mode-switch" aria-label="文件浏览模式">
      <button type="button" class="file-mode-tab is-active" data-browse-mode="workspace">工作区</button>
      <button type="button" class="file-mode-tab" data-browse-mode="system">系统只读</button>
    </div>
    <label id="system-root-field" class="field file-system-root hidden">
      <span>系统路径</span>
      <select id="system-root-select"></select>
    </label>
  `;
  fileHeader.after(controls);
}

function ensureWireguardBootstrapPanel() {
  const nodesView = document.getElementById("nodes-view");
  const nodesGrid = nodesView?.querySelector(".nodes-grid");
  if (!nodesGrid || document.getElementById("wireguard-bootstrap-form")) {
    return;
  }

  const panel = document.createElement("article");
  panel.className = "panel section-panel wireguard-bootstrap-panel span-full";
  panel.innerHTML = `
    <div class="section-head">
      <div>
        <p class="section-kicker">Bootstrap</p>
        <h2>WireGuard 接入指引</h2>
      </div>
    </div>
    <div class="wireguard-bootstrap-status-grid">
      <span id="wireguard-bootstrap-summary" class="ghost-chip">正在读取 manager WireGuard 状态...</span>
      <p id="wireguard-bootstrap-status" class="muted">等待 WireGuard 状态...</p>
      <p class="muted">引导模式适用于尚未配置 <code>wg0</code> 的新节点；如果目标机已存在 <code>/etc/wireguard/wg0.conf</code>，请先备份或删除。</p>
    </div>
    <form id="wireguard-bootstrap-form" class="settings-form">
      <label class="field">
        <span>Manager URL</span>
        <input
          id="wireguard-bootstrap-manager-url"
          spellcheck="false"
          placeholder="https://panel.example.com"
        />
      </label>
      <label class="field">
        <span>WireGuard Endpoint Host</span>
        <input
          id="wireguard-bootstrap-endpoint-host"
          spellcheck="false"
          placeholder="panel.example.com"
        />
      </label>
      <label class="field">
        <span>目标节点名称</span>
        <input
          id="wireguard-bootstrap-node-name"
          spellcheck="false"
          placeholder="la-node-01"
        />
      </label>
      <label class="field">
        <span>命令有效期</span>
        <select id="wireguard-bootstrap-expiry">
          <option value="15">15 分钟</option>
          <option value="20" selected>20 分钟</option>
          <option value="30">30 分钟</option>
          <option value="60">60 分钟</option>
        </select>
      </label>
      <label class="field span-2">
        <span>目标主机执行命令</span>
        <textarea
          id="wireguard-bootstrap-command"
          rows="5"
          readonly
          placeholder="先生成引导命令，然后复制到目标主机执行。"
        ></textarea>
      </label>
      <div class="form-actions span-2">
        <button id="generate-wireguard-bootstrap" type="submit">生成引导命令</button>
        <button id="copy-wireguard-bootstrap" type="button" class="secondary" disabled>复制命令</button>
      </div>
    </form>
  `;
  nodesGrid.appendChild(panel);
}

function ensureNodeUpdatePanel() {
  const nodesView = document.getElementById("nodes-view");
  const nodesGrid = nodesView?.querySelector(".nodes-grid");
  if (!nodesGrid || document.getElementById("node-update-form")) {
    return;
  }

  const panel = document.createElement("article");
  panel.className = "panel section-panel node-update-panel span-full";
  panel.innerHTML = `
    <div class="section-head">
      <div>
        <p class="section-kicker">版本更新</p>
        <h2>自动更新</h2>
        <p id="node-update-summary" class="muted" aria-live="polite">正在读取更新状态。</p>
      </div>
      <div class="section-actions">
        <button id="refresh-node-update-status" type="button" class="secondary">刷新状态</button>
      </div>
    </div>
    <div class="update-version-grid">
      <div class="update-version-card">
        <span>当前版本</span>
        <strong id="node-update-current-version">-</strong>
      </div>
      <div class="update-version-card">
        <span>发布通道</span>
        <strong id="node-update-channel-label">main</strong>
      </div>
      <div class="update-version-card">
        <span>最新版本</span>
        <strong id="node-update-latest-version">-</strong>
      </div>
      <div class="update-version-card">
        <span>检测结果</span>
        <strong id="node-update-availability">检查中</strong>
      </div>
    </div>
    <div id="node-update-status" class="update-status-list" aria-live="polite">正在读取更新能力。</div>
    <form id="node-update-form" class="settings-form">
      <label class="field">
        <span>发布通道</span>
        <select id="node-update-channel">
          <option value="stable">stable</option>
          <option value="rc">rc</option>
          <option value="main" selected>main</option>
        </select>
      </label>
      <label class="field">
        <span>更新方式</span>
        <select id="node-update-mode">
          <option value="quick" selected>快速同步</option>
          <option value="redeploy">重新部署</option>
          <option value="full-install">完整安装</option>
        </select>
      </label>
      <label class="toggle card-toggle span-2">
        <input id="node-update-pull-latest" type="checkbox" checked />
        <span>更新前先执行 <code>git pull --ff-only</code></span>
      </label>
      <div class="form-actions span-2">
        <button id="trigger-node-update" type="submit">立即更新</button>
        <button id="trigger-all-node-updates" type="button" class="secondary">更新所有 Agent</button>
      </div>
    </form>
  `;
  nodesGrid.appendChild(panel);
}

ensureWireguardBootstrapPanel();
ensureNodeUpdatePanel();
ensureFileBrowserControls();

export const dom = {
  appShell: document.getElementById("app-shell"),
  loginView: document.getElementById("login-view"),
  loginForm: document.getElementById("login-form"),
  loginTitleEl: document.getElementById("login-title"),
  loginSubtitleEl: document.getElementById("login-subtitle"),
  loginNotesEl: document.getElementById("login-notes"),
  loginUsernameLabelEl: document.getElementById("login-username-label"),
  loginPasswordLabelEl: document.getElementById("login-password-label"),
  loginUsernameInput: document.getElementById("login-username"),
  loginPasswordInput: document.getElementById("login-password"),
  loginConfirmFieldEl: document.getElementById("login-confirm-field"),
  loginConfirmInput: document.getElementById("login-confirm"),
  loginSubmitLabelEl: document.getElementById("login-submit-label"),
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
  configUpdateChannelInput: document.getElementById("config-update-channel"),
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
  wireguardBootstrapSummaryEl: document.getElementById("wireguard-bootstrap-summary"),
  wireguardBootstrapStatusEl: document.getElementById("wireguard-bootstrap-status"),
  wireguardBootstrapForm: document.getElementById("wireguard-bootstrap-form"),
  wireguardBootstrapManagerUrlInput: document.getElementById("wireguard-bootstrap-manager-url"),
  wireguardBootstrapEndpointHostInput: document.getElementById("wireguard-bootstrap-endpoint-host"),
  wireguardBootstrapNodeNameInput: document.getElementById("wireguard-bootstrap-node-name"),
  wireguardBootstrapExpiryInput: document.getElementById("wireguard-bootstrap-expiry"),
  wireguardBootstrapCommandInput: document.getElementById("wireguard-bootstrap-command"),
  generateWireguardBootstrapButton: document.getElementById("generate-wireguard-bootstrap"),
  copyWireguardBootstrapButton: document.getElementById("copy-wireguard-bootstrap"),
  nodeUpdateSummaryEl: document.getElementById("node-update-summary"),
  nodeUpdateCurrentVersionEl: document.getElementById("node-update-current-version"),
  nodeUpdateChannelLabelEl: document.getElementById("node-update-channel-label"),
  nodeUpdateLatestVersionEl: document.getElementById("node-update-latest-version"),
  nodeUpdateAvailabilityEl: document.getElementById("node-update-availability"),
  nodeUpdateStatusEl: document.getElementById("node-update-status"),
  nodeUpdateForm: document.getElementById("node-update-form"),
  nodeUpdateChannelInput: document.getElementById("node-update-channel"),
  nodeUpdateModeInput: document.getElementById("node-update-mode"),
  nodeUpdatePullLatestInput: document.getElementById("node-update-pull-latest"),
  triggerNodeUpdateButton: document.getElementById("trigger-node-update"),
  triggerAllNodeUpdatesButton: document.getElementById("trigger-all-node-updates"),
  refreshNodeUpdateStatusButton: document.getElementById("refresh-node-update-status"),
  filesEl: document.getElementById("files"),
  activePathLabel: document.getElementById("active-path"),
  pathBreadcrumbsEl: document.getElementById("path-breadcrumbs"),
  goUpButton: document.getElementById("go-up"),
  showHiddenToggle: document.getElementById("show-hidden-toggle"),
  fileModeTabs: document.querySelectorAll(".file-mode-tab"),
  systemRootField: document.getElementById("system-root-field"),
  systemRootSelect: document.getElementById("system-root-select"),
  fileModeNote: document.getElementById("file-mode-note"),
  statusEl: document.getElementById("status"),
  uploadInput: document.getElementById("upload-input"),
  uploadButton: document.getElementById("upload-button"),
  filePickerLabel: document.querySelector(".file-picker span"),
  createDirButton: document.getElementById("create-dir-button"),
  renameButton: document.getElementById("rename-button"),
  deleteButton: document.getElementById("delete-button"),
  downloadButton: document.getElementById("download-button"),
  overviewView: document.getElementById("overview-view"),
  guideView: document.getElementById("guide-view"),
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

export function persistSelectedServer(serverId, serverName) {
  if (Number.isInteger(serverId)) {
    window.localStorage.setItem(SELECTED_SERVER_ID_STORAGE_KEY, String(serverId));
    window.localStorage.setItem(SELECTED_SERVER_NAME_STORAGE_KEY, serverName || "");
    return;
  }
  window.localStorage.removeItem(SELECTED_SERVER_ID_STORAGE_KEY);
  window.localStorage.removeItem(SELECTED_SERVER_NAME_STORAGE_KEY);
}

export function loadPersistedSelectedServer() {
  const rawId = window.localStorage.getItem(SELECTED_SERVER_ID_STORAGE_KEY);
  if (rawId === null) {
    return { serverId: null, serverName: null };
  }
  const parsed = Number.parseInt(rawId, 10);
  if (!Number.isInteger(parsed)) {
    persistSelectedServer(null, null);
    return { serverId: null, serverName: null };
  }
  return {
    serverId: parsed,
    serverName: window.localStorage.getItem(SELECTED_SERVER_NAME_STORAGE_KEY) || null,
  };
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
  let requestPath = path;
  if (Number.isInteger(state.selectedServerId) && typeof path === "string" && path.startsWith("/api/")) {
    const url = new URL(path, window.location.origin);
    const excludedPrefixes = ["/api/auth", "/api/servers", "/api/bootstrap"];
    const excludedPaths = new Set(["/api/health", "/api/update/all-nodes"]);
    const isExcluded = excludedPaths.has(url.pathname)
      || excludedPrefixes.some((prefix) => url.pathname.startsWith(prefix));
    if (!isExcluded && !url.searchParams.has("server_id")) {
      url.searchParams.set("server_id", String(state.selectedServerId));
      requestPath = `${url.pathname}${url.search}${url.hash}`;
    }
  }

  const response = await fetch(requestPath, {
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
  dom.guideView.classList.toggle("hidden", normalizedView !== "guide");
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

export function setWireguardBootstrapPlaceholder(message) {
  if (dom.wireguardBootstrapSummaryEl) {
    dom.wireguardBootstrapSummaryEl.textContent = message;
  }
  if (dom.wireguardBootstrapStatusEl) {
    dom.wireguardBootstrapStatusEl.textContent = message;
  }
  if (dom.wireguardBootstrapCommandInput) {
    dom.wireguardBootstrapCommandInput.value = "";
  }
  if (dom.copyWireguardBootstrapButton) {
    dom.copyWireguardBootstrapButton.disabled = true;
  }
}

export function setUpdatePlaceholder(message) {
  if (dom.nodeUpdateSummaryEl) {
    dom.nodeUpdateSummaryEl.textContent = message;
  }
  if (dom.nodeUpdateCurrentVersionEl) {
    dom.nodeUpdateCurrentVersionEl.textContent = "-";
  }
  if (dom.nodeUpdateChannelLabelEl) {
    dom.nodeUpdateChannelLabelEl.textContent = "main";
  }
  if (dom.nodeUpdateLatestVersionEl) {
    dom.nodeUpdateLatestVersionEl.textContent = "-";
  }
  if (dom.nodeUpdateAvailabilityEl) {
    dom.nodeUpdateAvailabilityEl.textContent = "不可用";
  }
  if (dom.nodeUpdateChannelInput) {
    dom.nodeUpdateChannelInput.value = "main";
  }
  if (dom.nodeUpdateStatusEl) {
    dom.nodeUpdateStatusEl.textContent = message;
  }
  if (dom.triggerNodeUpdateButton) {
    dom.triggerNodeUpdateButton.disabled = true;
    dom.triggerNodeUpdateButton.textContent = "立即更新";
  }
  if (dom.triggerAllNodeUpdatesButton) {
    dom.triggerAllNodeUpdatesButton.disabled = true;
    dom.triggerAllNodeUpdatesButton.textContent = "更新所有 Agent";
  }
}

export function clearProtectedViews(message) {
  setResourcesPlaceholder(message);
  setChartPlaceholder(message);
  setFilesPlaceholder(message);
  setAccessPlaceholder(message);
  setConfigPlaceholder(message);
  setServersPlaceholder(message);
  setWireguardBootstrapPlaceholder(message);
  setUpdatePlaceholder(message);
  setLogsPlaceholder(message);
}
