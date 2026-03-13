import {
  clearProtectedViews,
  clearStatus,
  dom,
  getToken,
  getViewFromHash,
  request,
  setView,
  showStatus,
  state,
  syncAuthPanel,
  TOKEN_STORAGE_KEY,
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
import { loadResourcesSection } from "./resources.js";
import {
  configureDomain,
  loadConfig,
  loadAccess,
  saveConfig,
} from "./settings.js";


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
  dom.pathInput.value = agent.root_path;
  dom.activePathLabel.textContent = agent.root_path;
  dom.agentNameEl.textContent = agent.agent_name;
  dom.agentHostnameEl.textContent = agent.hostname;
  dom.agentUserEl.textContent = agent.current_user;
  syncAuthPanel(false);
}

async function refreshDashboard({ includeFiles = true, forceResourceRefresh = false } = {}) {
  const tasks = [loadResourcesSection({ forceRefresh: forceResourceRefresh })];
  if (includeFiles) {
    tasks.push(loadFiles());
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
}

async function refreshAll({ includeFiles = true, forceResourceRefresh = false } = {}) {
  clearStatus();
  const tasks = [
    refreshDashboard({ includeFiles, forceResourceRefresh }),
    loadAccess(),
  ];
  if (state.activeView === "settings") {
    tasks.push(loadConfig());
  }
  const results = await Promise.allSettled(tasks);
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure?.status === "rejected") {
    showStatus(firstFailure.reason.message, "error");
  }
}

async function saveToken() {
  const nextToken = dom.tokenInput.value.trim();
  if (!nextToken) {
    showStatus("请输入访问令牌", "error");
    return;
  }

  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
  dom.tokenInput.value = "";
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

function clearToken() {
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  state.access = null;
  state.config = null;
  state.selectedEntry = null;
  syncAuthPanel(true);
  clearProtectedViews("输入访问令牌后即可继续操作");
  showStatus("已清除当前会话令牌", "info");
}

function wireEvents() {
  dom.refreshButton.addEventListener("click", () =>
    refreshAll({ forceResourceRefresh: true }).catch((error) => showStatus(error.message, "error"))
  );
  dom.loadFilesButton.addEventListener("click", () => loadFiles().catch((error) => showStatus(error.message, "error")));
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
  dom.pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadFiles().catch((error) => showStatus(error.message, "error"));
    }
  });
  dom.tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveToken().catch((error) => showStatus(error.message, "error"));
    }
  });
  dom.viewTabs.forEach((button) => {
    button.addEventListener("click", () => {
      setView(button.dataset.view);
      if (button.dataset.view === "settings" && (!state.access || !state.config)) {
        Promise.allSettled([loadAccess(), loadConfig()]).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") {
            showStatus(failed.reason.message, "error");
          }
        });
      }
    });
  });
  window.addEventListener("hashchange", () => setView(getViewFromHash()));
}

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

wireEvents();
boot();
window.setInterval(() => {
  if (!state.authEnabled || getToken()) {
    refreshDashboard({ includeFiles: false }).catch(() => {});
    if (state.activeView === "settings") {
      loadAccess().catch(() => {});
    }
  }
}, 15000);
