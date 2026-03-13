const state = {
  activeServerId: null,
  activeServerName: "",
  selectedEntry: null,
};

const serverForm = document.getElementById("server-form");
const authMethodInput = document.getElementById("auth-method");
const passwordInput = document.getElementById("password-input");
const privateKeyInput = document.getElementById("private-key-input");
const serverList = document.getElementById("servers");
const refreshButton = document.getElementById("refresh-servers");
const resourcesEl = document.getElementById("resources");
const filesEl = document.getElementById("files");
const activeServerLabel = document.getElementById("active-server");
const pathInput = document.getElementById("path-input");
const loadFilesButton = document.getElementById("load-files");
const testConnectionButton = document.getElementById("test-connection");
const statusEl = document.getElementById("status");
const uploadInput = document.getElementById("upload-input");
const uploadButton = document.getElementById("upload-button");
const renameButton = document.getElementById("rename-button");
const deleteButton = document.getElementById("delete-button");
const downloadButton = document.getElementById("download-button");

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === "string" ? payload : payload.error || "request failed";
    throw new Error(message);
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

function syncAuthInputs() {
  const method = authMethodInput.value;
  const usingPassword = method === "password";

  passwordInput.classList.toggle("hidden", !usingPassword);
  privateKeyInput.classList.toggle("hidden", usingPassword);
  passwordInput.required = usingPassword;
  privateKeyInput.required = !usingPassword;
  if (usingPassword) {
    privateKeyInput.value = "";
  } else {
    passwordInput.value = "";
  }
}

async function loadServers() {
  const servers = await request("/api/servers");
  renderServers(servers);
}

function renderServers(servers) {
  if (!servers.length) {
    serverList.innerHTML = `<div class="empty">还没有服务器，先添加一台 Ubuntu 主机。</div>`;
    return;
  }

  serverList.innerHTML = servers
    .map(
      (server) => `
        <button class="server-item ${server.id === state.activeServerId ? "active" : ""}" data-id="${server.id}" data-name="${server.name}">
          <strong>${server.name}</strong>
          <span>${server.username}@${server.host}:${server.port}</span>
          <small>${server.auth_method}</small>
        </button>
      `
    )
    .join("");

  serverList.querySelectorAll(".server-item").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeServerId = button.dataset.id;
      state.activeServerName = button.dataset.name;
      state.selectedEntry = null;
      renderServers(servers);
      await loadActiveServer();
    });
  });
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
      <strong>${snapshot.load_average.one} / ${snapshot.load_average.five} / ${snapshot.load_average.fifteen}</strong>
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

function renderFiles(payload) {
  filesEl.classList.remove("empty");
  pathInput.value = payload.current_path;

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
          <small>${entry.mode}</small>
        </div>
        <span>${entry.file_type}</span>
        <span>${entry.size} B</span>
      </div>
    `
    )
    .join("");

  filesEl.querySelectorAll(".file-row").forEach((row) => {
    row.addEventListener("click", async () => {
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

async function loadActiveServer() {
  if (!state.activeServerId) {
    return;
  }

  activeServerLabel.textContent = state.activeServerName || "已选择服务器";
  clearStatus();

  const [resourcesResult, filesResult] = await Promise.allSettled([
    request(`/api/servers/${state.activeServerId}/resources`),
    request(
      `/api/servers/${state.activeServerId}/files?path=${encodeURIComponent(
        pathInput.value || "/"
      )}`
    ),
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
}

async function loadFiles() {
  if (!state.activeServerId) {
    throw new Error("请先选择服务器");
  }

  const payload = await request(
    `/api/servers/${state.activeServerId}/files?path=${encodeURIComponent(
      pathInput.value || "/"
    )}`
  );
  renderFiles(payload);
}

async function testConnection() {
  if (!state.activeServerId) {
    showStatus("请先选择服务器", "error");
    return;
  }

  try {
    const payload = await request(`/api/servers/${state.activeServerId}/test`, {
      method: "POST",
    });
    showStatus(payload.stdout, "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function uploadFile() {
  if (!state.activeServerId) {
    showStatus("请先选择服务器", "error");
    return;
  }

  const file = uploadInput.files[0];
  if (!file) {
    showStatus("请选择要上传的文件", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    await request(
      `/api/servers/${state.activeServerId}/files/upload?path=${encodeURIComponent(
        pathInput.value || "/"
      )}`,
      {
        method: "POST",
        body: formData,
      }
    );
    uploadInput.value = "";
    showStatus(`已上传 ${file.name}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function renameSelected() {
  if (!state.activeServerId || !state.selectedEntry) {
    showStatus("请先选择文件或目录", "error");
    return;
  }

  const nextName = window.prompt("输入新名称", state.selectedEntry.name);
  if (!nextName || nextName === state.selectedEntry.name) {
    return;
  }

  const currentDir = pathInput.value === "/" ? "/" : pathInput.value.replace(/\/$/, "");
  const newPath = currentDir === "/" ? `/${nextName}` : `${currentDir}/${nextName}`;

  try {
    await request(`/api/servers/${state.activeServerId}/files/rename`, {
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
  if (!state.activeServerId || !state.selectedEntry) {
    showStatus("请先选择文件或目录", "error");
    return;
  }

  const confirmed = window.confirm(`确认删除 ${state.selectedEntry.name} ?`);
  if (!confirmed) {
    return;
  }

  try {
    await request(
      `/api/servers/${state.activeServerId}/files?path=${encodeURIComponent(
        state.selectedEntry.path
      )}`,
      { method: "DELETE" }
    );
    showStatus(`已删除 ${state.selectedEntry.name}`, "success");
    state.selectedEntry = null;
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function downloadSelected() {
  if (!state.activeServerId || !state.selectedEntry) {
    showStatus("请先选择文件", "error");
    return;
  }
  if (state.selectedEntry.type !== "file") {
    showStatus("下载只支持普通文件", "error");
    return;
  }

  window.location.href = `/api/servers/${state.activeServerId}/files/download?path=${encodeURIComponent(
    state.selectedEntry.path
  )}`;
}

serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(serverForm);
  const payload = Object.fromEntries(formData.entries());
  payload.port = Number(payload.port);

  if (payload.auth_method === "password") {
    payload.private_key_path = "";
  } else {
    payload.password = "";
  }
  delete payload.auth_method;

  try {
    await request("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    serverForm.reset();
    authMethodInput.value = "password";
    syncAuthInputs();
    pathInput.value = "/";
    showStatus("服务器已添加", "success");
    await loadServers();
  } catch (error) {
    showStatus(error.message, "error");
  }
});

authMethodInput.addEventListener("change", syncAuthInputs);
refreshButton.addEventListener("click", () => loadServers().catch((error) => showStatus(error.message, "error")));
loadFilesButton.addEventListener("click", () => loadFiles().catch((error) => showStatus(error.message, "error")));
testConnectionButton.addEventListener("click", testConnection);
uploadButton.addEventListener("click", uploadFile);
renameButton.addEventListener("click", renameSelected);
deleteButton.addEventListener("click", deleteSelected);
downloadButton.addEventListener("click", downloadSelected);

syncAuthInputs();
loadServers().catch((error) => {
  serverList.innerHTML = `<div class="empty">${error.message}</div>`;
});
