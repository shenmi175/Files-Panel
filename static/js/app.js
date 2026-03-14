import {
  clearProtectedViews,
  clearStatus,
  dom,
  getToken,
  getViewFromHash,
  persistToken,
  request,
  removePersistedToken,
  setLogLevel,
  setView,
  showStatus,
  state,
  syncAuthPanel,
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

const AUTH_REQUIRED_MESSAGE = "输入访问令牌后即可读取当前页内容";
let autoRefreshHandle = 0;

function canAccessProtectedViews() {
  return !state.authEnabled || Boolean(getToken());
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
  dom.activePathLabel.textContent = agent.root_path;
  dom.agentNameEl.textContent = agent.agent_name;
  dom.agentHostnameEl.textContent = agent.hostname;
  dom.agentUserEl.textContent = agent.current_user;
  syncAuthPanel(false);
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

function nextAutoRefreshDelay() {
  if (state.activeView === "overview") {
    return Math.max((Number(state.resourceSampleInterval) || 15) * 1000, 2000);
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

async function handleTopLevelViewChange(view) {
  setView(view);
  if (!canAccessProtectedViews()) {
    clearProtectedViews(AUTH_REQUIRED_MESSAGE);
    scheduleAutoRefresh();
    return;
  }

  await refreshVisibleView({
    forceLogsReset: view === "logs",
    forceFilesReload: view === "files",
  });
  scheduleAutoRefresh();
}

async function saveToken() {
  const nextToken = dom.tokenInput.value.trim();
  if (!nextToken) {
    showStatus("请输入访问令牌", "error");
    return;
  }

  persistToken(nextToken);
  dom.tokenInput.value = "";
  syncAuthPanel(false);
  try {
    await refreshVisibleView({
      forceLogsReset: state.activeView === "logs",
      forceFilesReload: state.activeView === "files",
    });
    scheduleAutoRefresh();
    showStatus("访问令牌已生效", "success");
  } catch (error) {
    removePersistedToken();
    syncAuthPanel(true);
    scheduleAutoRefresh();
    showStatus(error.message, "error");
  }
}

function clearToken() {
  removePersistedToken();
  state.access = null;
  state.config = null;
  state.docker = null;
  state.filesLoaded = false;
  state.selectedEntry = null;
  state.servers = [];
  resetServerForm();
  resetLogsState();
  syncAuthPanel(true);
  clearProtectedViews(AUTH_REQUIRED_MESSAGE);
  scheduleAutoRefresh();
  showStatus("已清除当前浏览器中的访问令牌", "info");
}

function wireEvents() {
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
  dom.saveTokenButton.addEventListener("click", saveToken);
  dom.clearTokenButton.addEventListener("click", clearToken);
  dom.domainForm.addEventListener("submit", configureDomain);
  dom.configForm.addEventListener("submit", saveConfig);
  dom.configResetTokenButton?.addEventListener("click", () => {
    resetAgentToken().catch((error) => showStatus(error.message, "error"));
  });
  dom.serverForm.addEventListener("submit", saveServer);
  dom.resetServerFormButton.addEventListener("click", resetServerForm);
  dom.serversListEl.addEventListener("click", handleServersClick);
  dom.tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveToken().catch((error) => showStatus(error.message, "error"));
    }
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
}

async function boot() {
  setLogLevel(state.logLevel);
  setView(getViewFromHash());
  resetServerForm();
  resetLogsState();
  try {
    await loadHealth();
    await loadAgent();
    if (!state.authEnabled || getToken()) {
      await refreshVisibleView({
        forceLogsReset: state.activeView === "logs",
        forceFilesReload: state.activeView === "files",
      });
    } else {
      clearProtectedViews("输入访问令牌后即可读取节点信息");
    }
  } catch (error) {
    clearProtectedViews("初始化失败");
    showStatus(error.message, "error");
  } finally {
    scheduleAutoRefresh();
  }
}

wireEvents();
boot();
