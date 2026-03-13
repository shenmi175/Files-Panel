import {
  dom,
  escapeHtml,
  fileTypeGlyph,
  formatTimestamp,
  getToken,
  joinPath,
  request,
  setFilesPlaceholder,
  showStatus,
  state,
} from "./shared.js";

function buildFilesUrl(targetPath) {
  const params = new URLSearchParams();
  params.set("path", targetPath || "/");
  if (state.showHidden) {
    params.set("show_hidden", "true");
  }
  return `/api/files?${params.toString()}`;
}

export function navigateToPath(targetPath) {
  state.currentPath = targetPath || "/";
  return loadFiles();
}

function buildBreadcrumbs(currentPath, rootPath) {
  const root = rootPath || "/";
  const crumbs = [];
  const rootLabel = root === "/" ? "/" : root.split("/").filter(Boolean).slice(-1)[0] || root;
  crumbs.push({ label: rootLabel, path: root });

  if (currentPath === root) {
    return crumbs;
  }

  const relative = currentPath.startsWith(root)
    ? currentPath.slice(root.length).replace(/^\/+/, "")
    : currentPath.replace(/^\/+/, "");
  const parts = relative ? relative.split("/").filter(Boolean) : [];
  let cursor = root === "/" ? "" : root;
  parts.forEach((part) => {
    cursor = cursor === "/" || cursor === "" ? `/${part}` : `${cursor}/${part}`;
    crumbs.push({ label: part, path: cursor });
  });
  return crumbs;
}

function renderBreadcrumbs(currentPath, rootPath) {
  const crumbs = buildBreadcrumbs(currentPath, rootPath);
  dom.pathBreadcrumbsEl.innerHTML = crumbs
    .map(
      (crumb, index) => `
        <button
          class="crumb ${index === crumbs.length - 1 ? "is-current" : ""}"
          type="button"
          data-path="${escapeHtml(crumb.path)}"
        >
          ${escapeHtml(crumb.label)}
        </button>
      `
    )
    .join('<span class="crumb-sep">/</span>');

  dom.pathBreadcrumbsEl.querySelectorAll(".crumb").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.classList.contains("is-current")) {
        return;
      }
      state.selectedEntry = null;
      await navigateToPath(button.dataset.path);
    });
  });
}

export function renderFiles(payload) {
  state.currentPath = payload.current_path;
  state.parentPath = payload.parent_path;
  state.showHidden = payload.show_hidden;
  dom.showHiddenToggle.checked = payload.show_hidden;
  dom.activePathLabel.textContent = payload.show_hidden
    ? `${payload.current_path} · 已显示隐藏文件`
    : `${payload.current_path} · 默认隐藏点文件`;
  renderBreadcrumbs(payload.current_path, payload.root_path);

  if (state.selectedEntry && !payload.entries.some((entry) => entry.path === state.selectedEntry.path)) {
    state.selectedEntry = null;
  }

  if (!payload.entries.length) {
    setFilesPlaceholder(payload.show_hidden ? "目录为空" : "目录为空，或当前只有隐藏文件");
    return;
  }

  dom.filesEl.className = "file-list";
  dom.filesEl.innerHTML = payload.entries
    .map((entry) => {
      const selected = state.selectedEntry?.path === entry.path ? "selected" : "";
      return `
        <div class="file-row ${selected}" data-path="${escapeHtml(entry.path)}" data-type="${escapeHtml(entry.file_type)}" data-name="${escapeHtml(entry.name)}">
          <div class="file-main">
            <button
              type="button"
              class="entry-link ${entry.file_type === "directory" ? "is-directory" : ""}"
            >
              <span class="entry-glyph">${fileTypeGlyph(entry.file_type)}</span>
              <strong>${escapeHtml(entry.name)}</strong>
              <span class="entry-meta">
                <span>${escapeHtml(entry.mode)}</span>
                <span>${escapeHtml(formatTimestamp(entry.modified_epoch))}</span>
              </span>
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  const highlightSelection = () => {
    dom.filesEl.querySelectorAll(".file-row").forEach((row) => {
      row.classList.toggle("selected", row.dataset.path === state.selectedEntry?.path);
    });
  };

  dom.filesEl.querySelectorAll(".file-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedEntry = {
        path: row.dataset.path,
        type: row.dataset.type,
        name: row.dataset.name,
      };
      highlightSelection();
    });

    row.addEventListener("dblclick", async () => {
      if (row.dataset.type === "directory") {
        state.selectedEntry = null;
        await navigateToPath(row.dataset.path);
      }
    });
  });
}

export async function loadFiles() {
  const payload = await request(buildFilesUrl(state.currentPath || "/"));
  state.filesLoaded = true;
  renderFiles(payload);
}

export function goUp() {
  if (!state.parentPath) {
    return;
  }
  navigateToPath(state.parentPath).catch((error) => showStatus(error.message, "error"));
}

export async function uploadFile() {
  const file = dom.uploadInput.files[0];
  if (!file) {
    showStatus("请选择要上传的文件", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    await request(`/api/files/upload?path=${encodeURIComponent(state.currentPath || "/")}`, {
      method: "POST",
      body: formData,
    });
    dom.uploadInput.value = "";
    dom.filePickerLabel.textContent = "选择文件";
    showStatus(`已上传 ${file.name}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function createDirectory() {
  const nextName = window.prompt("输入新目录名称");
  if (!nextName) {
    return;
  }

  try {
    await request("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: joinPath(state.currentPath || "/", nextName),
      }),
    });
    showStatus(`已创建目录 ${nextName}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function renameSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择文件或目录", "error");
    return;
  }

  const nextName = window.prompt("输入新名称", state.selectedEntry.name);
  if (!nextName || nextName === state.selectedEntry.name) {
    return;
  }

  try {
    await request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        old_path: state.selectedEntry.path,
        new_path: joinPath(state.currentPath || "/", nextName),
      }),
    });
    state.selectedEntry = null;
    showStatus(`已重命名为 ${nextName}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function deleteSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择文件或目录", "error");
    return;
  }

  const confirmed = window.confirm(`确认删除 ${state.selectedEntry.name} ?`);
  if (!confirmed) {
    return;
  }

  try {
    const selectedName = state.selectedEntry.name;
    await request(`/api/files?path=${encodeURIComponent(state.selectedEntry.path)}`, {
      method: "DELETE",
    });
    state.selectedEntry = null;
    showStatus(`已删除 ${selectedName}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function downloadSelected() {
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
      throw new Error(payload?.detail || "request failed");
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
