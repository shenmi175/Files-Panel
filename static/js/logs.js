import {
  dom,
  request,
  setLogsPlaceholder,
  state,
} from "./shared.js";

function setText(node, value) {
  if (!node) {
    return;
  }
  const nextValue = String(value ?? "");
  if (node.textContent !== nextValue) {
    node.textContent = nextValue;
  }
}

function createLogLineElement(line) {
  const wrapper = document.createElement("div");
  wrapper.className = "log-line";
  wrapper.innerHTML = `
    <div class="log-meta-line">
      <span class="log-time"></span>
      <span class="log-unit"></span>
      <span class="log-priority hidden"></span>
      <span class="log-pid hidden"></span>
    </div>
    <pre></pre>
  `;
  updateLogLineElement(wrapper, line);
  return wrapper;
}

function updateLogLineElement(wrapper, line) {
  setText(wrapper.querySelector(".log-time"), line.timestamp);
  setText(wrapper.querySelector(".log-unit"), line.unit || "files-agent");

  const priorityEl = wrapper.querySelector(".log-priority");
  const hasPriority = Boolean(line.priority);
  priorityEl?.classList.toggle("hidden", !hasPriority);
  setText(priorityEl, hasPriority ? `P${line.priority}` : "");

  const pidEl = wrapper.querySelector(".log-pid");
  const hasPid = line.pid !== null && line.pid !== undefined;
  pidEl?.classList.toggle("hidden", !hasPid);
  setText(pidEl, hasPid ? `pid ${line.pid}` : "");

  setText(wrapper.querySelector("pre"), line.message);
}

function rebuildLogOutput(lines) {
  const fragment = document.createDocumentFragment();
  lines.forEach((line) => {
    fragment.appendChild(createLogLineElement(line));
  });
  dom.logsOutputEl.replaceChildren(fragment);
}

function appendLogOutput(lines, overflow, stickToBottom) {
  if (!lines.length) {
    return;
  }

  const fragment = document.createDocumentFragment();
  lines.forEach((line) => {
    fragment.appendChild(createLogLineElement(line));
  });
  dom.logsOutputEl.appendChild(fragment);

  let removedHeight = 0;
  for (let index = 0; index < overflow; index += 1) {
    const firstChild = dom.logsOutputEl.firstElementChild;
    if (!firstChild) {
      break;
    }
    removedHeight += firstChild.getBoundingClientRect().height;
    firstChild.remove();
  }

  if (!stickToBottom && removedHeight > 0) {
    dom.logsOutputEl.scrollTop = Math.max(0, dom.logsOutputEl.scrollTop - removedHeight);
  }
}

function renderLogs(payload, { append = false } = {}) {
  dom.logsServiceEl.textContent = payload.service_name || "files-agent";

  if (!payload.available) {
    state.logsLoaded = false;
    setLogsPlaceholder(payload.message || "当前无法读取日志。");
    return;
  }

  const stickToBottom =
    dom.logsOutputEl.classList.contains("empty")
    || dom.logsOutputEl.scrollTop + dom.logsOutputEl.clientHeight >= dom.logsOutputEl.scrollHeight - 32;

  const payloadLines = Array.isArray(payload.lines) ? payload.lines : [];
  const previousLineCount = state.logLines.length;
  const nextLines = append ? [...state.logLines, ...payloadLines] : [...payloadLines];
  const overflow = append ? Math.max(0, previousLineCount + payloadLines.length - 200) : 0;
  state.logLines = nextLines.slice(-200);
  state.logsCursor = payload.cursor || state.logsCursor;
  state.logsLoaded = true;

  const levelFilter = String(payload.level_filter || state.logLevel || "info");
  dom.logsSummaryEl.textContent = payload.message
    ? payload.message
    : `${levelFilter.toUpperCase()} · 最近 ${state.logLines.length} / 200 条`;
  dom.logsCursorEl.textContent = state.logsCursor ? "游标已建立" : "尚未建立游标";

  if (!state.logLines.length) {
    dom.logsOutputEl.className = "log-stream empty";
    dom.logsOutputEl.textContent = payload.message || "当前没有匹配的日志。";
    return;
  }

  dom.logsOutputEl.className = "log-stream";
  if (append && !dom.logsOutputEl.classList.contains("empty") && previousLineCount > 0) {
    appendLogOutput(payloadLines, overflow, stickToBottom);
  } else {
    rebuildLogOutput(state.logLines);
  }
  if (stickToBottom) {
    dom.logsOutputEl.scrollTop = dom.logsOutputEl.scrollHeight;
  }
}

export function resetLogsState(message = "正在加载日志...") {
  state.logsLoaded = false;
  state.logsCursor = null;
  state.logLines = [];
  setLogsPlaceholder(message);
}

export async function loadLogsSection({ reset = false } = {}) {
  const params = new URLSearchParams();
  params.set("limit", "200");
  params.set("level", state.logLevel);
  if (!reset && state.logsCursor) {
    params.set("cursor", state.logsCursor);
  }

  if (reset) {
    resetLogsState("正在切换日志级别...");
  }

  const payload = await request(`/api/runtime/logs?${params.toString()}`);
  renderLogs(payload, { append: !reset && Boolean(state.logsCursor) });
}
