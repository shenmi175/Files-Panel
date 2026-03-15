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

function normalizedBrowseMode() {
  return state.fileBrowseMode === "system" ? "system" : "workspace";
}

function effectiveTargetPath(targetPath) {
  if (targetPath) {
    return targetPath;
  }
  if (normalizedBrowseMode() === "system") {
    return state.selectedSystemRoot || state.systemRoots[0] || null;
  }
  return state.currentPath || state.agent?.root_path || null;
}

function buildFilesUrl(targetPath) {
  const params = new URLSearchParams();
  const nextPath = effectiveTargetPath(targetPath);
  if (nextPath) {
    params.set("path", nextPath);
  }
  if (state.showHidden) {
    params.set("show_hidden", "true");
  }
  if (normalizedBrowseMode() === "system") {
    params.set("browse_mode", "system");
  }
  return `/api/files?${params.toString()}`;
}

function buildDownloadLinkUrl(targetPath) {
  const params = new URLSearchParams();
  params.set("path", targetPath);
  if (normalizedBrowseMode() === "system") {
    params.set("browse_mode", "system");
  }
  return `/api/files/download-link?${params.toString()}`;
}

function updateFileActionState() {
  const readOnly = Boolean(state.fileReadOnly);
  const title = readOnly ? "系统只读模式下不允许写操作" : "";
  [
    dom.uploadButton,
    dom.createDirButton,
    dom.renameButton,
    dom.deleteButton,
    dom.uploadInput,
  ].forEach((element) => {
    if (!element) {
      return;
    }
    element.disabled = readOnly;
    if ("title" in element) {
      element.title = title;
    }
  });

  if (dom.fileModeNote) {
    dom.fileModeNote.textContent = readOnly
      ? "系统只读模式由目标主机上的特权 helper 只读列目录和下载文件，不允许上传、删除、重命名或新建。"
      : "工作区模式使用 AGENT_ROOT 边界，支持上传、删除、重命名和新建目录。";
  }
}

function renderSystemRootOptions() {
  if (!dom.systemRootSelect || !dom.systemRootField) {
    return;
  }
  const roots = Array.isArray(state.systemRoots) ? state.systemRoots : [];
  const hasRoots = roots.length > 0;
  dom.systemRootField.classList.toggle("hidden", normalizedBrowseMode() !== "system");
  dom.systemRootSelect.innerHTML = roots
    .map((root) => `<option value="${escapeHtml(root)}">${escapeHtml(root)}</option>`)
    .join("");
  if (hasRoots) {
    const selected = state.selectedSystemRoot && roots.includes(state.selectedSystemRoot)
      ? state.selectedSystemRoot
      : roots[0];
    state.selectedSystemRoot = selected;
    dom.systemRootSelect.value = selected;
  }
}

function syncFileModeTabs() {
  dom.fileModeTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.browseMode === normalizedBrowseMode());
  });
  renderSystemRootOptions();
  updateFileActionState();
}

export function navigateToPath(targetPath) {
  state.currentPath = targetPath || null;
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
  state.fileBrowseMode = payload.browse_mode === "system" ? "system" : "workspace";
  state.fileReadOnly = Boolean(payload.read_only);
  state.systemRoots = Array.isArray(payload.system_roots) ? payload.system_roots : [];
  state.currentPath = payload.current_path;
  state.parentPath = payload.parent_path;
  state.showHidden = payload.show_hidden;
  if (state.fileBrowseMode === "system") {
    state.selectedSystemRoot = payload.root_path;
  }
  dom.showHiddenToggle.checked = payload.show_hidden;
  dom.activePathLabel.textContent = payload.show_hidden
    ? `${payload.current_path} · 默认显示隐藏文件`
    : payload.current_path;
  renderBreadcrumbs(payload.current_path, payload.root_path);
  syncFileModeTabs();

  if (state.selectedEntry && !payload.entries.some((entry) => entry.path === state.selectedEntry.path)) {
    state.selectedEntry = null;
  }

  if (!payload.entries.length) {
    setFilesPlaceholder(payload.show_hidden ? "当前目录为空。" : "当前目录为空，或隐藏文件未显示。");
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
  const payload = await request(buildFilesUrl(state.currentPath));
  state.filesLoaded = true;
  renderFiles(payload);
}

export function switchFileBrowseMode(mode) {
  const nextMode = mode === "system" ? "system" : "workspace";
  if (state.fileBrowseMode === nextMode && state.filesLoaded) {
    return;
  }
  state.selectedEntry = null;
  state.fileBrowseMode = nextMode;
  state.currentPath = nextMode === "system"
    ? (state.selectedSystemRoot || state.systemRoots[0] || "/root")
    : (state.agent?.root_path || null);
  loadFiles().catch((error) => showStatus(error.message, "error"));
}

export function selectSystemRoot(rootPath) {
  if (!rootPath) {
    return;
  }
  state.selectedSystemRoot = rootPath;
  state.selectedEntry = null;
  state.currentPath = rootPath;
  loadFiles().catch((error) => showStatus(error.message, "error"));
}

export function goUp() {
  if (!state.parentPath) {
    return;
  }
  navigateToPath(state.parentPath).catch((error) => showStatus(error.message, "error"));
}

export async function uploadFile() {
  if (state.fileReadOnly) {
    showStatus("系统只读模式下不允许上传文件。", "error");
    return;
  }

  const file = dom.uploadInput.files[0];
  if (!file) {
    showStatus("请选择要上传的文件。", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    await request(
      `/api/files/upload?path=${encodeURIComponent(state.currentPath || "/")}&browse_mode=${encodeURIComponent(
        normalizedBrowseMode()
      )}`,
      {
        method: "POST",
        body: formData,
      }
    );
    dom.uploadInput.value = "";
    dom.filePickerLabel.textContent = "选择文件";
    showStatus(`已上传 ${file.name}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function createDirectory() {
  if (state.fileReadOnly) {
    showStatus("系统只读模式下不允许新建目录。", "error");
    return;
  }

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
        browse_mode: normalizedBrowseMode(),
      }),
    });
    showStatus(`已创建目录 ${nextName}`, "success");
    await loadFiles();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function renameSelected() {
  if (state.fileReadOnly) {
    showStatus("系统只读模式下不允许重命名。", "error");
    return;
  }
  if (!state.selectedEntry) {
    showStatus("请先选择一个条目。", "error");
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
        browse_mode: normalizedBrowseMode(),
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
  if (state.fileReadOnly) {
    showStatus("系统只读模式下不允许删除。", "error");
    return;
  }
  if (!state.selectedEntry) {
    showStatus("请先选择要删除的条目。", "error");
    return;
  }

  const confirmed = window.confirm(`确认删除 ${state.selectedEntry.name} 吗？`);
  if (!confirmed) {
    return;
  }

  try {
    const selectedName = state.selectedEntry.name;
    await request(
      `/api/files?path=${encodeURIComponent(state.selectedEntry.path)}&browse_mode=${encodeURIComponent(
        normalizedBrowseMode()
      )}`,
      {
        method: "DELETE",
      }
    );
    state.selectedEntry = null;
    showStatus(`已删除 ${selectedName}`, "success");
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
    showStatus("当前只支持下载文件，不支持直接下载目录。", "error");
    return;
  }

  try {
    const payload = await request(buildDownloadLinkUrl(state.selectedEntry.path));
    const downloadUrl = payload.url;
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
