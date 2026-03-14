import {
  clearProtectedViews,
  clearStatus,
  dom,
  getToken,
  getViewFromHash,
  persistToken,
  request,
  removePersistedToken,
  setDashboardPanel,
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
import { resetLogsState, loadLogsSection } from "./logs.js";
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

let autoRefreshHandle = 0;

function ensureConfigResetTokenButton() {
  if (dom.configResetTokenButton) {
    return;
  }
  const saveButton = document.getElementById("save-config");
  if (!saveButton || !saveButton.parentElement) {
    return;
  }

  const button = document.createElement("button");
  button.id = "config-reset-token";
  button.type = "button";
  button.className = "secondary";
  button.textContent = "重置令牌";
  saveButton.parentElement.insertBefore(button, saveButton);
  dom.configResetTokenButton = button;
}

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

function nextAutoRefreshDelay() {
  if (state.activeView === "dashboard" && state.activeDashboardPanel === "resources") {
    return Math.max((Number(state.resourceSampleInterval) || 15) * 1000, 2000);
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

      if (state.activeView === "dashboard" && state.activeDashboardPanel === "resources") {
        await loadResourcesSection();
        return;
      }

      if (state.activeView === "settings") {
        await refreshSettings();
        return;
      }

      if (state.activeView === "logs") {
        await loadLogsSection();
      }
    } catch {
      // Keep background refresh alive even if one request fails.
    } finally {
      scheduleAutoRefresh();
    }
  }, nextAutoRefreshDelay());
}

async function loadDashboardPanel(panel, { forceResourceRefresh = false } = {}) {
  if (panel === "files") {
    await loadFiles();
    return;
  }
  await loadResourcesSection({ forceRefresh: forceResourceRefresh });
}

async function refreshVisibleView({
  forceResourceRefresh = false,
  forceLogsReset = false,
} = {}) {
  clearStatus();
  if (state.activeView === "settings") {
    await refreshSettings();
    return;
  }

  const tasks = [loadAccess()];

  if (state.activeView === "dashboard") {
    tasks.push(loadDashboardPanel(state.activeDashboardPanel, { forceResourceRefresh }));
  } else if (state.activeView === "logs") {
    tasks.push(loadLogsSection({ reset: forceLogsReset || !state.logsLoaded }));
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
}

async function handleTopLevelViewChange(view) {
  setView(view);
  if (!canAccessProtectedViews()) {
    clearProtectedViews("输入访问令牌后即可继续操作");
    scheduleAutoRefresh();
    return;
  }

  if (view === "settings") {
    await refreshSettings();
    scheduleAutoRefresh();
    return;
  }

  await loadAccess();

  if (view === "dashboard") {
    await loadDashboardPanel(state.activeDashboardPanel);
    scheduleAutoRefresh();
    return;
  }

  if (view === "logs") {
    await loadLogsSection({ reset: !state.logsLoaded });
  }
  scheduleAutoRefresh();
}

async function handleDashboardPanelChange(panel) {
  setDashboardPanel(panel);
  if (!canAccessProtectedViews()) {
    clearProtectedViews("输入访问令牌后即可继续操作");
    scheduleAutoRefresh();
    return;
  }
  if (panel === "files" && !state.filesLoaded) {
    await loadFiles();
    scheduleAutoRefresh();
    return;
  }
  if (panel === "resources") {
    await loadResourcesSection();
  }
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
    await refreshVisibleView({ forceLogsReset: true });
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
  clearProtectedViews("输入访问令牌后即可继续操作");
  scheduleAutoRefresh();
  showStatus("已清除当前会话令牌", "info");
}

function wireEvents() {
  dom.refreshButton.addEventListener("click", () =>
    refreshVisibleView({ forceResourceRefresh: true }).catch((error) => showStatus(error.message, "error"))
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
      handleTopLevelViewChange(button.dataset.view).catch((error) => showStatus(error.message, "error"));
    });
  });
  dom.dashboardPanelTabs.forEach((button) => {
    button.addEventListener("click", () => {
      handleDashboardPanelChange(button.dataset.panel).catch((error) => showStatus(error.message, "error"));
    });
  });
  window.addEventListener("hashchange", () => {
    handleTopLevelViewChange(getViewFromHash()).catch((error) => showStatus(error.message, "error"));
  });
}

async function boot() {
  setDashboardPanel(state.activeDashboardPanel);
  setLogLevel(state.logLevel);
  setView(getViewFromHash());
  resetServerForm();
  resetLogsState();
  try {
    await loadHealth();
    await loadAgent();
    if (!state.authEnabled || getToken()) {
      await refreshVisibleView({ forceLogsReset: true });
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

ensureConfigResetTokenButton();
wireEvents();
boot();
