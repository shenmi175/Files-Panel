import {
  clearProtectedViews,
  clearStatus,
  dom,
  formatError,
  getViewFromHash,
  loadPersistedSelectedServer,
  persistSelectedServer,
  removePersistedToken,
  request,
  setLogLevel,
  setView,
  showStatus,
  state,
  updateHeroAccess,
} from "./shared.js";
import {
  createDirectory,
  deleteSelected,
  downloadSelected,
  goUp,
  loadFiles,
  renameSelected,
  selectSystemRoot,
  switchFileBrowseMode,
  uploadFile,
} from "./files.js";
import { loadLogsSection, resetLogsState } from "./logs.js";
import { loadResourcesSection } from "./resources.js";
import {
  configureDomain,
  copyWireguardBootstrapCommand,
  generateWireguardBootstrap,
  handleServersClick,
  loadAccess,
  refreshSettings,
  resetAgentToken,
  resetServerForm,
  saveConfig,
  saveServer,
  triggerAllNodeUpdates,
  triggerNodeUpdate,
} from "./settings.js";

const AUTH_REQUIRED_MESSAGE = "请先登录后再访问面板内容。";
const BACKGROUND_PRELOAD_DELAY_MS = 1200;
let autoRefreshHandle = 0;
let backgroundPreloadHandle = 0;

function canAccessProtectedViews() {
  return !state.authEnabled || state.isAuthenticated;
}

function isViewWarm(view) {
  switch (view) {
    case "overview":
      return state.accessLoaded && state.resourcesLoaded;
    case "files":
      return state.filesLoaded;
    case "guide":
      return true;
    case "access":
      return state.accessLoaded && state.configLoaded;
    case "nodes":
      return state.accessLoaded
        && state.serversLoaded
        && state.wireguardBootstrapLoaded
        && state.updateStatusLoaded;
    case "logs":
      return state.accessLoaded && state.logsLoaded;
    default:
      return false;
  }
}

function setLoginMessage(message, type = "info") {
  if (!message) {
    dom.loginMessageEl.textContent = "";
    dom.loginMessageEl.className = "auth-feedback hidden";
    return;
  }
  dom.loginMessageEl.textContent = message;
  dom.loginMessageEl.className = `auth-feedback ${type}`;
}

function renderLoginMode() {
  const isRegistration = state.registrationRequired;
  dom.loginTitleEl.textContent = isRegistration ? "注册管理员账号" : "登录管理平台";
  dom.loginSubtitleEl.textContent = isRegistration
    ? "首次使用请创建管理员账号。"
    : "请输入管理员账号和密码。";
  dom.loginConfirmFieldEl.classList.toggle("hidden", !isRegistration);
  dom.loginSubmitLabelEl.textContent = isRegistration ? "创建账号" : "登录";
  dom.loginPasswordInput.autocomplete = isRegistration ? "new-password" : "current-password";
  if (!isRegistration) {
    dom.loginConfirmInput.value = "";
  }
}

function resetAgentSummary() {
  dom.agentNameEl.textContent = "等待加载";
  dom.agentHostnameEl.textContent = "-";
  dom.agentUserEl.textContent = "-";
  updateHeroAccess();
}

function clearBackgroundPreloadHandle() {
  if (!backgroundPreloadHandle) {
    return;
  }
  if ("cancelIdleCallback" in window) {
    window.cancelIdleCallback(backgroundPreloadHandle);
  } else {
    window.clearTimeout(backgroundPreloadHandle);
  }
  backgroundPreloadHandle = 0;
}

function resetProtectedState() {
  clearBackgroundPreloadHandle();
  state.agent = null;
  state.access = null;
  state.config = null;
  state.docker = null;
  state.resourcesLoaded = false;
  state.filesLoaded = false;
  state.accessLoaded = false;
  state.configLoaded = false;
  state.serversLoaded = false;
  state.wireguardBootstrapLoaded = false;
  state.wireguardBootstrapStatus = null;
  state.updateStatusLoaded = false;
  state.updateStatus = null;
  state.logsLoaded = false;
  state.preloadStarted = false;
  state.selectedEntry = null;
  state.fileBrowseMode = "workspace";
  state.fileReadOnly = false;
  state.systemRoots = [];
  state.selectedSystemRoot = null;
  state.servers = [];
  resetServerForm();
  resetLogsState();
  resetAgentSummary();
}

function resetSelectedNodeData() {
  clearBackgroundPreloadHandle();
  state.agent = null;
  state.access = null;
  state.config = null;
  state.docker = null;
  state.resourcesLoaded = false;
  state.filesLoaded = false;
  state.accessLoaded = false;
  state.configLoaded = false;
  state.logsLoaded = false;
  state.wireguardBootstrapLoaded = false;
  state.wireguardBootstrapStatus = null;
  state.updateStatusLoaded = false;
  state.updateStatus = null;
  state.logsCursor = null;
  state.logLines = [];
  state.preloadStarted = false;
  state.selectedEntry = null;
  state.fileBrowseMode = "workspace";
  state.fileReadOnly = false;
  state.systemRoots = [];
  state.selectedSystemRoot = null;
  state.currentPath = null;
  state.parentPath = null;
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function showLoginView(message = "") {
  dom.appShell.classList.add("hidden");
  dom.loginView.classList.remove("hidden");
  dom.logoutButton.classList.add("hidden");
  clearStatus();
  clearProtectedViews(AUTH_REQUIRED_MESSAGE);
  renderLoginMode();
  setLoginMessage(
    message || (state.registrationRequired ? "请先注册管理员账号。" : "请输入账号密码后登录。")
  );
  window.setTimeout(() => {
    dom.loginUsernameInput?.focus();
  }, 0);
}

function showAppShell() {
  dom.loginView.classList.add("hidden");
  dom.appShell.classList.remove("hidden");
  dom.logoutButton.classList.toggle("hidden", !state.authEnabled || !state.isAuthenticated);
  setLoginMessage("");
}

async function parseJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function loadHealth() {
  const response = await fetch("/api/health", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await response.json();
  state.authEnabled = Boolean(payload.auth_enabled);
  state.registrationRequired = Boolean(payload.registration_required);
  if (!state.authEnabled) {
    state.isAuthenticated = true;
  }
}

async function loadSession() {
  if (!state.authEnabled) {
    state.isAuthenticated = true;
    return;
  }

  const response = await fetch("/api/auth/session", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await response.json();
  state.authEnabled = Boolean(payload.auth_enabled);
  state.isAuthenticated = Boolean(payload.authenticated);
  state.registrationRequired = Boolean(payload.registration_required);
  state.sessionUsername = payload.username || null;
}

async function loadAgent() {
  const agent = await request("/api/agent");
  state.agent = agent;
  state.selectedServerName = agent.agent_name;
  state.currentPath = agent.root_path;
  state.parentPath = null;
  dom.activePathLabel.textContent = agent.root_path;
  dom.agentNameEl.textContent = agent.agent_name;
  dom.agentHostnameEl.textContent = agent.hostname;
  dom.agentUserEl.textContent = agent.current_user;
  updateHeroAccess();
}

async function loadCurrentView({
  forceResourceRefresh = false,
  forceLogsReset = false,
  forceFilesReload = false,
} = {}) {
  switch (state.activeView) {
    case "overview":
      await Promise.all([
        loadAccess(),
        loadResourcesSection({ forceRefresh: forceResourceRefresh }),
      ]);
      return;
    case "files":
      await Promise.all([
        loadAccess(),
        forceFilesReload || !state.filesLoaded ? loadFiles() : Promise.resolve(),
      ]);
      return;
    case "guide":
      return;
    case "access":
      await refreshSettings({ includeConfig: true, includeServers: false });
      return;
    case "nodes":
      await refreshSettings({ includeConfig: false, includeServers: true });
      return;
    case "logs":
      await Promise.all([
        loadAccess(),
        loadLogsSection({ reset: forceLogsReset || !state.logsLoaded }),
      ]);
      return;
    default:
      await Promise.all([loadAccess(), loadResourcesSection()]);
  }
}

function startBackgroundPreload() {
  if (!canAccessProtectedViews() || state.preloadStarted) {
    return;
  }

  state.preloadStarted = true;
  clearBackgroundPreloadHandle();

  const runPreload = async () => {
    const tasks = [];

    if (!(state.accessLoaded && state.configLoaded && state.serversLoaded)) {
      tasks.push(() => refreshSettings({ includeConfig: true, includeServers: true }));
    }
    if (!state.resourcesLoaded) {
      tasks.push(() => loadResourcesSection());
    }
    if (!state.filesLoaded) {
      tasks.push(() => loadFiles());
    }
    if (!state.logsLoaded) {
      tasks.push(() => loadLogsSection());
    }

    for (const task of tasks) {
      if (!state.preloadStarted || !canAccessProtectedViews()) {
        return;
      }
      await Promise.resolve(task()).catch(() => {});
      await yieldToMainThread();
    }
  };

  const startPreload = () => {
    backgroundPreloadHandle = 0;
    if (!state.preloadStarted || !canAccessProtectedViews()) {
      return;
    }
    void runPreload();
  };

  if ("requestIdleCallback" in window) {
    backgroundPreloadHandle = window.requestIdleCallback(startPreload, {
      timeout: BACKGROUND_PRELOAD_DELAY_MS,
    });
    return;
  }

  backgroundPreloadHandle = window.setTimeout(startPreload, BACKGROUND_PRELOAD_DELAY_MS);
}

function nextAutoRefreshDelay() {
  if (state.activeView === "overview") {
    return Math.max((Number(state.resourceSampleInterval) || 5) * 1000, 2000);
  }
  if (state.activeView === "logs") {
    return 8000;
  }
  return 15000;
}

function scheduleAutoRefresh() {
  if (autoRefreshHandle) {
    window.clearTimeout(autoRefreshHandle);
  }
  autoRefreshHandle = window.setTimeout(async () => {
    try {
      if (!canAccessProtectedViews()) {
        return;
      }
      if (document.hidden) {
        return;
      }

      switch (state.activeView) {
        case "overview":
          await Promise.all([loadAccess(), loadResourcesSection()]);
          return;
        case "access":
          await refreshSettings({ includeConfig: true, includeServers: false });
          return;
        case "nodes":
          await refreshSettings({ includeConfig: false, includeServers: true });
          return;
        case "logs":
          await Promise.all([loadAccess(), loadLogsSection()]);
          return;
        case "files":
        default:
          await loadAccess();
      }
    } catch {
      // Keep background refresh alive even if one request fails.
    } finally {
      scheduleAutoRefresh();
    }
  }, nextAutoRefreshDelay());
}

async function refreshVisibleView({
  forceResourceRefresh = false,
  forceLogsReset = false,
  forceFilesReload = false,
} = {}) {
  clearStatus();
  await loadCurrentView({
    forceResourceRefresh,
    forceLogsReset,
    forceFilesReload,
  });
}

async function enterAuthenticatedApp({
  forceResourceRefresh = false,
  forceLogsReset = false,
  forceFilesReload = false,
} = {}) {
  showAppShell();
  await loadAgent();
  await refreshVisibleView({
    forceResourceRefresh,
    forceLogsReset,
    forceFilesReload,
  });
  scheduleAutoRefresh();
  startBackgroundPreload();
}

async function switchServerSelection(serverId, serverName = null) {
  const normalizedServerId = Number.isInteger(serverId) ? serverId : null;
  if (state.selectedServerId === normalizedServerId && state.selectedServerName === serverName) {
    return;
  }

  state.selectedServerId = normalizedServerId;
  state.selectedServerName = serverName;
  persistSelectedServer(normalizedServerId, serverName);

  if (!canAccessProtectedViews()) {
    return;
  }

  resetSelectedNodeData();
  resetLogsState("正在切换节点...");
  clearProtectedViews("正在切换节点...");
  showStatus(`正在切换到 ${serverName || "本机节点"}...`, "info", { autoClearMs: 3000 });
  await enterAuthenticatedApp({
    forceResourceRefresh: true,
    forceLogsReset: true,
    forceFilesReload: true,
  });
  showStatus(`已切换到 ${state.selectedServerName || "本机节点"}`, "success", { autoClearMs: 4000 });
}

function handleUnauthenticatedState(message) {
  state.isAuthenticated = false;
  state.sessionUsername = null;
  resetProtectedState();
  showLoginView(message);
  scheduleAutoRefresh();
}

async function submitAuth(event) {
  event.preventDefault();
  const username = dom.loginUsernameInput.value.trim();
  const password = dom.loginPasswordInput.value;
  const confirmPassword = dom.loginConfirmInput.value;

  if (!username) {
    setLoginMessage("请输入用户名。", "error");
    return;
  }
  if (!password) {
    setLoginMessage("请输入密码。", "error");
    return;
  }
  if (state.registrationRequired && password !== confirmPassword) {
    setLoginMessage("两次输入的密码不一致。", "error");
    return;
  }

  const endpoint = state.registrationRequired ? "/api/auth/register" : "/api/auth/login";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    setLoginMessage(formatError(payload), "error");
    return;
  }

  state.isAuthenticated = true;
  state.registrationRequired = false;
  state.sessionUsername = payload.username || username;
  state.preloadStarted = false;
  dom.loginUsernameInput.value = "";
  dom.loginPasswordInput.value = "";
  dom.loginConfirmInput.value = "";
  setLoginMessage("");
  await enterAuthenticatedApp({
    forceLogsReset: false,
    forceFilesReload: state.activeView === "files",
  });
}

async function logout() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // Best-effort logout.
  }

  state.registrationRequired = false;
  handleUnauthenticatedState("已退出登录。");
}

async function handleTopLevelViewChange(view) {
  setView(view);
  if (!canAccessProtectedViews()) {
    handleUnauthenticatedState(AUTH_REQUIRED_MESSAGE);
    return;
  }

  const refreshPromise = refreshVisibleView({
    forceLogsReset: false,
    forceFilesReload: view === "files",
  });

  scheduleAutoRefresh();
  startBackgroundPreload();

  if (isViewWarm(view)) {
    refreshPromise.catch((error) => showStatus(error.message, "error"));
    return;
  }

  await refreshPromise;
}

function wireEvents() {
  dom.loginForm.addEventListener("submit", (event) => {
    submitAuth(event).catch((error) => setLoginMessage(error.message, "error"));
  });
  dom.logoutButton?.addEventListener("click", () => {
    logout().catch((error) => setLoginMessage(error.message, "error"));
  });
  dom.refreshButton.addEventListener("click", () =>
    refreshVisibleView({ forceResourceRefresh: true }).catch((error) =>
      showStatus(error.message, "error")
    )
  );
  dom.logsRefreshButton.addEventListener("click", () =>
    loadLogsSection({ reset: true }).catch((error) => showStatus(error.message, "error"))
  );
  dom.logLevelTabs.forEach((button) => {
    button.addEventListener("click", () => {
      if (state.logLevel === button.dataset.level) {
        return;
      }
      setLogLevel(button.dataset.level);
      resetLogsState();
      if (state.activeView === "logs") {
        loadLogsSection({ reset: true }).catch((error) => showStatus(error.message, "error"));
      }
      scheduleAutoRefresh();
    });
  });
  dom.goUpButton.addEventListener("click", goUp);
  dom.showHiddenToggle.addEventListener("change", () => {
    state.showHidden = dom.showHiddenToggle.checked;
    state.selectedEntry = null;
    loadFiles().catch((error) => showStatus(error.message, "error"));
  });
  dom.fileModeTabs.forEach((button) => {
    button.addEventListener("click", () => {
      switchFileBrowseMode(button.dataset.browseMode);
    });
  });
  dom.systemRootSelect?.addEventListener("change", () => {
    selectSystemRoot(dom.systemRootSelect.value);
  });
  dom.uploadButton.addEventListener("click", uploadFile);
  dom.uploadInput.addEventListener("change", () => {
    dom.filePickerLabel.textContent = dom.uploadInput.files[0]?.name || "选择文件";
  });
  dom.createDirButton.addEventListener("click", createDirectory);
  dom.renameButton.addEventListener("click", renameSelected);
  dom.deleteButton.addEventListener("click", deleteSelected);
  dom.downloadButton.addEventListener("click", downloadSelected);
  dom.domainForm.addEventListener("submit", configureDomain);
  dom.configForm.addEventListener("submit", saveConfig);
  dom.configResetTokenButton?.addEventListener("click", () => {
    resetAgentToken().catch((error) => showStatus(error.message, "error"));
  });
  dom.serverForm.addEventListener("submit", saveServer);
  dom.resetServerFormButton.addEventListener("click", resetServerForm);
  dom.serversListEl.addEventListener("click", handleServersClick);
  dom.wireguardBootstrapForm?.addEventListener("submit", (event) => {
    generateWireguardBootstrap(event).catch((error) => showStatus(error.message, "error"));
  });
  dom.copyWireguardBootstrapButton?.addEventListener("click", () => {
    copyWireguardBootstrapCommand().catch((error) => showStatus(error.message, "error"));
  });
  dom.nodeUpdateForm?.addEventListener("submit", (event) => {
    triggerNodeUpdate(event).catch((error) => showStatus(error.message, "error"));
  });
  dom.triggerAllNodeUpdatesButton?.addEventListener("click", () => {
    triggerAllNodeUpdates().catch((error) => showStatus(error.message, "error"));
  });
  dom.refreshNodeUpdateStatusButton?.addEventListener("click", () => {
    refreshSettings({ includeConfig: false, includeServers: true }).catch((error) =>
      showStatus(error.message, "error")
    );
  });
  dom.viewTabs.forEach((button) => {
    button.addEventListener("click", () => {
      handleTopLevelViewChange(button.dataset.view).catch((error) =>
        showStatus(error.message, "error")
      );
    });
  });
  window.addEventListener("hashchange", () => {
    handleTopLevelViewChange(getViewFromHash()).catch((error) =>
      showStatus(error.message, "error")
    );
  });
  window.addEventListener("auth:expired", (event) => {
    const message = event.detail?.message || "登录会话已失效，请重新登录。";
    handleUnauthenticatedState(message);
  });
  window.addEventListener("server:selected", (event) => {
    const nextServerId = event.detail?.serverId;
    const nextServerName = event.detail?.serverName || null;
    switchServerSelection(nextServerId, nextServerName).catch((error) =>
      showStatus(error.message, "error")
    );
  });
}

async function boot() {
  setLogLevel(state.logLevel);
  setView(getViewFromHash());
  resetServerForm();
  resetLogsState();
  removePersistedToken();
  resetAgentSummary();
  const persistedServer = loadPersistedSelectedServer();
  state.selectedServerId = persistedServer.serverId;
  state.selectedServerName = persistedServer.serverName;

  try {
    await loadHealth();
    await loadSession();

    if (!state.authEnabled || state.isAuthenticated) {
      try {
        await enterAuthenticatedApp({
          forceLogsReset: false,
          forceFilesReload: state.activeView === "files",
        });
      } catch (error) {
        if (state.selectedServerId !== null) {
          persistSelectedServer(null, null);
          state.selectedServerId = null;
          state.selectedServerName = null;
          resetSelectedNodeData();
          await enterAuthenticatedApp({
            forceLogsReset: false,
            forceFilesReload: state.activeView === "files",
          });
          showStatus(
            `${error.message}；已回退到 manager 本机视图。`,
            "info",
            { autoClearMs: 7000 }
          );
        } else {
          throw error;
        }
      }
    } else {
      showLoginView(
        state.registrationRequired
          ? "请先注册管理员账号。"
          : "请输入账号密码后登录。"
      );
    }
  } catch (error) {
    if (state.authEnabled && !state.isAuthenticated) {
      showLoginView(error.message);
    } else {
      showAppShell();
      clearProtectedViews("应用初始化失败。");
      showStatus(error.message, "error");
    }
  } finally {
    scheduleAutoRefresh();
  }
}

wireEvents();
boot();
