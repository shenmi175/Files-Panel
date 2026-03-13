const TOKEN_STORAGE_KEY = "files_agent_token";

const state = {
  agent: null,
  access: null,
  authEnabled: false,
  selectedEntry: null,
  currentPath: "/",
  parentPath: null,
};

const agentNameEl = document.getElementById("agent-name");
const agentHostnameEl = document.getElementById("agent-hostname");
const agentUserEl = document.getElementById("agent-user");
const agentRootEl = document.getElementById("agent-root");
const agentAuthEl = document.getElementById("agent-auth");
const authPanel = document.getElementById("auth-panel");
const tokenInput = document.getElementById("token-input");
const saveTokenButton = document.getElementById("save-token");
const clearTokenButton = document.getElementById("clear-token");
const refreshButton = document.getElementById("refresh-dashboard");
const resourcesEl = document.getElementById("resources");
const accessSummaryEl = document.getElementById("access-summary");
const accessCardsEl = document.getElementById("access-cards");
const domainForm = document.getElementById("domain-form");
const domainInput = document.getElementById("domain-input");
const filesEl = document.getElementById("files");
const activePathLabel = document.getElementById("active-path");
const pathInput = document.getElementById("path-input");
const loadFilesButton = document.getElementById("load-files");
const goUpButton = document.getElementById("go-up");
const statusEl = document.getElementById("status");
const uploadInput = document.getElementById("upload-input");
const uploadButton = document.getElementById("upload-button");
const createDirButton = document.getElementById("create-dir-button");
const renameButton = document.getElementById("rename-button");
const deleteButton = document.getElementById("delete-button");
const downloadButton = document.getElementById("download-button");

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

function syncAuthPanel(forceVisible = false) {
  const visible = state.authEnabled && (forceVisible || !getToken());
  authPanel.classList.toggle("hidden", !visible);
  agentAuthEl.textContent = state.authEnabled
    ? getToken()
      ? "已启用 Bearer Token"
      : "需要 Bearer Token"
    : "未启用访问令牌";
}

function setAccessPlaceholder(message) {
  accessCardsEl.classList.add("empty");
  accessCardsEl.textContent = message;
  accessSummaryEl.textContent = message;
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

function joinPath(basePath, nextName) {
  const normalizedBase = basePath === "/" ? "/" : basePath.replace(/\/$/, "");
  return normalizedBase === "/" ? `/${nextName}` : `${normalizedBase}/${nextName}`;
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
  pathInput.value = agent.root_path;
  activePathLabel.textContent = agent.root_path;
  agentNameEl.textContent = agent.agent_name;
  agentHostnameEl.textContent = agent.hostname;
  agentUserEl.textContent = agent.current_user;
  agentRootEl.textContent = agent.root_path;
  syncAuthPanel(false);
}

function renderResources(snapshot) {
  resourcesEl.classList.remove("empty");
  resourcesEl.innerHTML = `
    <div class="card">
      <span>主机</span>
      <strong>${snapshot.hostname}</strong>
      <small>${snapshot.uptime}</small>
    </div>
    <div class="card">
      <span>Load</span>
      <strong>${snapshot.load_average.one.toFixed(2)} / ${snapshot.load_average.five.toFixed(2)} / ${snapshot.load_average.fifteen.toFixed(2)}</strong>
      <small>1m / 5m / 15m</small>
    </div>
    <div class="card">
      <span>内存</span>
      <strong>${snapshot.memory.used_mb} / ${snapshot.memory.total_mb} MB</strong>
      <small>available ${snapshot.memory.available_mb} MB</small>
    </div>
    <div class="card">
      <span>磁盘</span>
      <strong>${snapshot.root_disk.used} / ${snapshot.root_disk.total}</strong>
      <small>${snapshot.root_disk.mount_point} · ${snapshot.root_disk.used_percent}</small>
    </div>
  `;
}

function renderAccess(payload) {
  state.access = payload;
  accessCardsEl.classList.remove("empty");

  const publicAccess = payload.public_url
    ? payload.public_url
    : payload.public_ip_access_enabled
      ? `http://服务器IP:${payload.desired_bind_port}`
      : "仅本地监听";
  const nginxStatus = payload.nginx_available
    ? payload.nginx_running
      ? "已安装并运行"
      : "已安装，等待 reload"
    : "未安装";

  if (payload.public_url) {
    accessSummaryEl.textContent = payload.restart_pending
      ? `域名已接入：${payload.public_url}，agent 正在切回仅本地监听`
      : `域名已接入：${payload.public_url}`;
  } else if (payload.public_ip_access_enabled) {
    accessSummaryEl.textContent = `当前临时开放 IP:${payload.desired_bind_port} 访问`;
  } else {
    accessSummaryEl.textContent = "当前只接受本地访问";
  }

  accessCardsEl.innerHTML = `
    <div class="card">
      <span>当前监听</span>
      <strong>${payload.current_bind_host}:${payload.current_bind_port}</strong>
      <small>${payload.restart_pending ? "重启后会切换到新的监听地址" : "当前生效"}</small>
    </div>
    <div class="card">
      <span>目标监听</span>
      <strong>${payload.desired_bind_host}:${payload.desired_bind_port}</strong>
      <small>${payload.public_ip_access_enabled ? "临时允许通过 IP 访问" : "域名完成后仅本地监听"}</small>
    </div>
    <div class="card">
      <span>对外入口</span>
      <strong>${publicAccess}</strong>
      <small>${payload.token_configured ? "Bearer Token 已配置" : "未配置访问令牌"}</small>
    </div>
    <div class="card">
      <span>Nginx / Certbot</span>
      <strong>${nginxStatus}</strong>
      <small>${payload.https_enabled ? "HTTPS 已就绪" : payload.certbot_available ? "证书将在域名接入时申请" : "未检测到 certbot"}</small>
    </div>
  `;
}

function renderFiles(payload) {
  filesEl.classList.remove("empty");
  pathInput.value = payload.current_path;
  state.currentPath = payload.current_path;
  state.parentPath = payload.parent_path;
  activePathLabel.textContent = payload.current_path;

  if (!payload.entries.length) {
    filesEl.innerHTML = `<div class="empty">目录为空</div>`;
    return;
  }

  filesEl.innerHTML = payload.entries
    .map(
      (entry) => `
      <div class="file-row ${state.selectedEntry?.path === entry.path ? "selected" : ""}" data-path="${entry.path}" data-type="${entry.file_type}">
        <div>
          <strong>${entry.name}</strong>
          <small>${entry.mode} · ${formatTimestamp(entry.modified_epoch)}</small>
        </div>
        <span>${entry.file_type}</span>
        <span>${formatBytes(entry.size)}</span>
        <span>${entry.path}</span>
      </div>
    `
    )
    .join("");

  filesEl.querySelectorAll(".file-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedEntry = {
        path: row.dataset.path,
        type: row.dataset.type,
        name: row.querySelector("strong").textContent,
      };
      renderFiles(payload);
      if (row.dataset.type === "directory") {
        pathInput.value = row.dataset.path;
      }
    });

    row.addEventListener("dblclick", async () => {
      if (row.dataset.type !== "directory") {
        return;
      }
      pathInput.value = row.dataset.path;
      await loadFiles();
    });
  });
}

async function loadAccess() {
  const payload = await request("/api/access");
  renderAccess(payload);
}

async function refreshDashboard() {
  clearStatus();
  const requestedPath = pathInput.value || state.currentPath || "/";

  const [resourcesResult, filesResult, accessResult] = await Promise.allSettled([
    request("/api/resources"),
    request(`/api/files?path=${encodeURIComponent(requestedPath)}`),
    request("/api/access"),
  ]);

  if (resourcesResult.status === "fulfilled") {
    renderResources(resourcesResult.value);
  } else {
    resourcesEl.classList.add("empty");
    resourcesEl.textContent = resourcesResult.reason.message;
    showStatus(resourcesResult.reason.message, "error");
  }

  if (filesResult.status === "fulfilled") {
    renderFiles(filesResult.value);
  } else {
    filesEl.classList.add("empty");
    filesEl.textContent = "目录加载失败";
    showStatus(filesResult.reason.message, "error");
  }

  if (accessResult.status === "fulfilled") {
    renderAccess(accessResult.value);
  } else {
    setAccessPlaceholder(accessResult.reason.message);
    showStatus(accessResult.reason.message, "error");
  }
}

async function loadFiles() {
  const payload = await request(`/api/files?path=${encodeURIComponent(pathInput.value || "/")}`);
  renderFiles(payload);
}

function goUp() {
  if (!state.parentPath) {
    return;
  }
  pathInput.value = state.parentPath;
  loadFiles().catch((error) => showStatus(error.message, "error"));
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
    await request(`/api/files/upload?path=${encodeURIComponent(pathInput.value || "/")}`, {
      method: "POST",
      body: formData,
    });
    uploadInput.value = "";
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

  const newPath = joinPath(pathInput.value || state.currentPath, nextName);

  try {
    await request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        old_path: state.selectedEntry.path,
        new_path: newPath,
      }),
    });
    showStatus(`已重命名为 ${nextName}`, "success");
    state.selectedEntry = null;
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
    showStatus(`已删除 ${state.selectedEntry.name}`, "success");
    state.selectedEntry = null;
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
        ? `域名已通过 nginx 接入：${payload.public_url}。agent 将自动切回仅本地监听，请随后改用域名访问。`
        : `域名已接入：${payload.public_url}`,
      "success"
    );
    loadAccess().catch(() => {});
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
  try {
    tokenInput.value = "";
    syncAuthPanel(false);
    await refreshDashboard();
    showStatus("访问令牌已生效", "success");
  } catch (error) {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    syncAuthPanel(true);
    showStatus(error.message, "error");
  }
}

function clearToken() {
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  syncAuthPanel(true);
  setAccessPlaceholder("输入访问令牌后可查看当前接入状态");
  showStatus("已清除当前会话令牌", "info");
}

refreshButton.addEventListener("click", () => refreshDashboard().catch((error) => showStatus(error.message, "error")));
loadFilesButton.addEventListener("click", () => loadFiles().catch((error) => showStatus(error.message, "error")));
goUpButton.addEventListener("click", goUp);
uploadButton.addEventListener("click", uploadFile);
createDirButton.addEventListener("click", createDirectory);
renameButton.addEventListener("click", renameSelected);
deleteButton.addEventListener("click", deleteSelected);
downloadButton.addEventListener("click", downloadSelected);
saveTokenButton.addEventListener("click", saveToken);
clearTokenButton.addEventListener("click", clearToken);
domainForm.addEventListener("submit", configureDomain);
pathInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadFiles().catch((error) => showStatus(error.message, "error"));
  }
});

async function boot() {
  try {
    await loadHealth();
    await loadAgent();
    if (!state.authEnabled || getToken()) {
      await refreshDashboard();
    } else {
      resourcesEl.textContent = "输入访问令牌后即可读取本机资源。";
      filesEl.textContent = "输入访问令牌后即可浏览目录。";
      setAccessPlaceholder("输入访问令牌后可查看当前接入状态");
    }
  } catch (error) {
    resourcesEl.classList.add("empty");
    resourcesEl.textContent = error.message;
    filesEl.classList.add("empty");
    filesEl.textContent = "初始化失败";
    setAccessPlaceholder("初始化失败");
    showStatus(error.message, "error");
  }
}

boot();
window.setInterval(() => {
  if (!state.authEnabled || getToken()) {
    request("/api/resources")
      .then(renderResources)
      .catch(() => {});
  }
}, 15000);
