import {
  dom,
  escapeHtml,
  fileTypeGlyph,
  fileTypeLabel,
  formatBytes,
  formatTimestamp,
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

function renderFileRow(entry) {
  const selected = state.selectedEntry?.path === entry.path ? "selected" : "";
  return `
    <div
      class="file-row ${selected}"
      data-path="${escapeHtml(entry.path)}"
      data-type="${escapeHtml(entry.file_type)}"
      data-name="${escapeHtml(entry.name)}"
    >
      <div class="file-cell file-cell-name">
        <button
          type="button"
          class="entry-link ${entry.file_type === "directory" ? "is-directory" : ""}"
        >
          <span class="entry-glyph">${fileTypeGlyph(entry.file_type)}</span>
          <span class="entry-copy">
            <strong>${escapeHtml(entry.name)}</strong>
            <small>${escapeHtml(entry.path)}</small>
          </span>
        </button>
      </div>
      <div class="file-cell file-cell-meta">
        <span class="entry-tag">${escapeHtml(fileTypeLabel(entry.file_type))}</span>
        <span class="entry-tag">${escapeHtml(entry.mode)}</span>
      </div>
      <div class="file-cell file-cell-size">${escapeHtml(formatBytes(entry.size))}</div>
      <div class="file-cell file-cell-time">${escapeHtml(formatTimestamp(entry.modified_epoch))}</div>
    </div>
  `;
}

export function renderFiles(payload) {
  state.currentPath = payload.current_path;
  state.parentPath = payload.parent_path;
  state.showHidden = payload.show_hidden;
  dom.showHiddenToggle.checked = payload.show_hidden;
  dom.activePathLabel.textContent = payload.show_hidden
    ? `${payload.current_path} · 默认显示隐藏文件`
    : payload.current_path;
  renderBreadcrumbs(payload.current_path, payload.root_path);

  if (state.selectedEntry && !payload.entries.some((entry) => entry.path === state.selectedEntry.path)) {
    state.selectedEntry = null;
  }

  if (!payload.entries.length) {
    setFilesPlaceholder(payload.show_hidden ? "当前目录为空" : "当前目录为空，隐藏文件未显示");
    return;
  }

  dom.filesEl.className = "file-list";
  dom.filesEl.innerHTML = payload.entries.map(renderFileRow).join("");

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
    showStatus("请先选择要上传的文件。", "error");
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
    showStatus(`已上传 ${file.name}。`, "success");
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
    showStatus(`已创建目录 ${nextName}。`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function renameSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择要重命名的项目。", "error");
    return;
  }

  const nextName = window.prompt("输入新的名称", state.selectedEntry.name);
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
    showStatus(`已重命名为 ${nextName}。`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function deleteSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择要删除的项目。", "error");
    return;
  }

  const confirmed = window.confirm(`确认删除 ${state.selectedEntry.name} 吗？`);
  if (!confirmed) {
    return;
  }

  try {
    const selectedName = state.selectedEntry.name;
    await request(`/api/files?path=${encodeURIComponent(state.selectedEntry.path)}`, {
      method: "DELETE",
    });
    state.selectedEntry = null;
    showStatus(`已删除 ${selectedName}。`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function downloadSelected() {
  if (!state.selectedEntry) {
    showStatus("请先选择要下载的文件。", "error");
    return;
  }
  if (state.selectedEntry.type !== "file") {
    showStatus("当前仅支持下载文件，不支持直接下载目录。", "error");
    return;
  }

  try {
    const downloadUrl = `/api/files/download?path=${encodeURIComponent(state.selectedEntry.path)}`;
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = state.selectedEntry.name;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    showStatus(error.message, "error");
  }
}
