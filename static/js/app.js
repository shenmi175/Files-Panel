import {
  clearProtectedViews,
  clearStatus,
  dom,
  formatError,
  getViewFromHash,
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
  uploadFile,
} from "./files.js";
import { loadLogsSection, resetLogsState } from "./logs.js";
import { loadResourcesSection } from "./resources.js";
import {
  configureDomain,
  handleServersClick,
  loadAccess,
  refreshSettings,
  resetAgentToken,
  resetServerForm,
  saveConfig,
  saveServer,
} from "./settings.js";

const AUTH_REQUIRED_MESSAGE = "请先登录后再访问控制面板。";
let autoRefreshHandle = 0;

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
      return state.accessLoaded && state.serversLoaded;
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

function resetAgentSummary() {
  dom.agentNameEl.textContent = "待登录";
  dom.agentHostnameEl.textContent = "-";
  dom.agentUserEl.textContent = "-";
  updateHeroAccess();
}

function resetProtectedState() {
  state.agent = null;
  state.access = null;
  state.config = null;
  state.docker = null;
  state.resourcesLoaded = false;
  state.filesLoaded = false;
  state.accessLoaded = false;
  state.configLoaded = false;
  state.serversLoaded = false;
  state.logsLoaded = false;
  state.preloadStarted = false;
  state.selectedEntry = null;
  state.servers = [];
  resetServerForm();
  resetLogsState();
  resetAgentSummary();
}

function showLoginView(message = "") {
  dom.appShell.classList.add("hidden");
  dom.loginView.classList.remove("hidden");
  dom.logoutButton.classList.add("hidden");
  clearStatus();
  clearProtectedViews(AUTH_REQUIRED_MESSAGE);
  setLoginMessage(message || "请输入访问令牌后登录控制面板。");
  window.setTimeout(() => {
    dom.loginTokenInput?.focus();
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
  state.isAuthenticated = Boolean(payload.authenticated);
}

async function loadAgent() {
  const agent = await request("/api/agent");
  state.agent = agent;
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
  void (async () => {
    const tasks = [];

    if (!(state.accessLoaded && state.configLoaded && state.serversLoaded)) {
      tasks.push(refreshSettings({ includeConfig: true, includeServers: true }));
    }
    if (!state.resourcesLoaded) {
      tasks.push(loadResourcesSection());
    }
    if (!state.filesLoaded) {
      tasks.push(loadFiles());
    }
    if (!state.logsLoaded) {
      tasks.push(loadLogsSection());
    }

    await Promise.allSettled(tasks.map((task) => Promise.resolve(task).catch(() => {})));
  })();
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
      // Keep the background refresh alive even if one request fails.
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

function handleUnauthenticatedState(message) {
  state.isAuthenticated = false;
  resetProtectedState();
  showLoginView(message);
  scheduleAutoRefresh();
}

async function submitLogin(event) {
  event.preventDefault();
  const token = dom.loginTokenInput.value.trim();
  if (!token) {
    setLoginMessage("请输入访问令牌。", "error");
    return;
  }

  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    setLoginMessage(formatError(payload), "error");
    return;
  }

  state.isAuthenticated = true;
  state.preloadStarted = false;
  dom.loginTokenInput.value = "";
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
    // The session cookie is best-effort cleared server-side; continue locally.
  }

  handleUnauthenticatedState("登录会话已退出。");
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
    submitLogin(event).catch((error) => setLoginMessage(error.message, "error"));
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
    const message = event.detail?.message || "登录已失效，请重新输入访问令牌。";
    handleUnauthenticatedState(message);
  });
}

async function boot() {
  setLogLevel(state.logLevel);
  setView(getViewFromHash());
  resetServerForm();
  resetLogsState();
  removePersistedToken();
  resetAgentSummary();

  try {
    await loadHealth();
    await loadSession();

    if (!state.authEnabled || state.isAuthenticated) {
      await enterAuthenticatedApp({
        forceLogsReset: false,
        forceFilesReload: state.activeView === "files",
      });
    } else {
      showLoginView("请输入访问令牌后登录控制面板。");
    }
  } catch (error) {
    if (state.authEnabled && !state.isAuthenticated) {
      showLoginView(error.message);
    } else {
      showAppShell();
      clearProtectedViews("初始化控制面板失败。");
      showStatus(error.message, "error");
    }
  } finally {
    scheduleAutoRefresh();
  }
}

wireEvents();
boot();
