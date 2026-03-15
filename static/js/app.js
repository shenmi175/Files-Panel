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

const AUTH_REQUIRED_MESSAGE = "请先登录后再访问面板内容。";
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

function renderLoginMode() {
  const isRegistration = state.registrationRequired;
  dom.loginTitleEl.textContent = isRegistration ? "注册管理员账号" : "登录管理平台";
  dom.loginSubtitleEl.textContent = isRegistration
    ? "首次使用需要创建一个本地管理员账号；浏览器登录使用账号密码，不再直接暴露节点令牌。"
    : "请输入管理员账号密码登录；会话通过 HttpOnly Cookie 保存，关闭会话后需要重新登录。";
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

function resetSelectedNodeData() {
  state.agent = null;
  state.access = null;
  state.config = null;
  state.docker = null;
  state.resourcesLoaded = false;
  state.filesLoaded = false;
  state.accessLoaded = false;
  state.configLoaded = false;
  state.logsLoaded = false;
  state.logsCursor = null;
  state.logLines = [];
  state.preloadStarted = false;
  state.selectedEntry = null;
  state.currentPath = "/";
  state.parentPath = null;
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

  try {
    await loadHealth();
    await loadSession();

    if (!state.authEnabled || state.isAuthenticated) {
      await enterAuthenticatedApp({
        forceLogsReset: false,
        forceFilesReload: state.activeView === "files",
      });
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
