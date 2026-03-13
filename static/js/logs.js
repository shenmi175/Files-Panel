import {
  dom,
  escapeHtml,
  request,
  setLogsPlaceholder,
  state,
} from "./shared.js";


const MAX_LOG_LINES = 320;


function renderLogLine(line) {
  return `
    <div class="log-line">
      <div class="log-meta-line">
        <span class="log-time">${escapeHtml(line.timestamp)}</span>
        <span class="log-unit">${escapeHtml(line.unit || "files-agent")}</span>
        ${
          line.priority
            ? `<span class="log-priority">P${escapeHtml(line.priority)}</span>`
            : ""
        }
        ${
          line.pid !== null && line.pid !== undefined
            ? `<span class="log-pid">pid ${escapeHtml(String(line.pid))}</span>`
            : ""
        }
      </div>
      <pre>${escapeHtml(line.message)}</pre>
    </div>
  `;
}


function renderLogs(payload, { append = false } = {}) {
  dom.logsServiceEl.textContent = payload.service_name || "files-agent";

  if (!payload.available) {
    state.logsLoaded = false;
    setLogsPlaceholder(payload.message || "日志暂不可用");
    return;
  }

  const stickToBottom =
    dom.logsOutputEl.classList.contains("empty")
    || dom.logsOutputEl.scrollTop + dom.logsOutputEl.clientHeight >= dom.logsOutputEl.scrollHeight - 32;

  const nextLines = append
    ? [...state.logLines, ...payload.lines]
    : [...payload.lines];
  state.logLines = nextLines.slice(-MAX_LOG_LINES);
  state.logsCursor = payload.cursor || state.logsCursor;
  state.logsLoaded = true;

  dom.logsSummaryEl.textContent = payload.message
    ? payload.message
    : `已加载 ${state.logLines.length} 条日志`;
  dom.logsCursorEl.textContent = state.logsCursor ? "游标已建立" : "游标未建立";

  if (!state.logLines.length) {
    dom.logsOutputEl.className = "log-stream empty";
    dom.logsOutputEl.textContent = payload.message || "暂无日志";
    return;
  }

  dom.logsOutputEl.className = "log-stream";
  dom.logsOutputEl.innerHTML = state.logLines.map(renderLogLine).join("");
  if (stickToBottom) {
    dom.logsOutputEl.scrollTop = dom.logsOutputEl.scrollHeight;
  }
}


export function resetLogsState() {
  state.logsLoaded = false;
  state.logsCursor = null;
  state.logLines = [];
  setLogsPlaceholder("输入访问令牌后即可查看实时日志");
}


export async function loadLogsSection({ reset = false } = {}) {
  const params = new URLSearchParams();
  params.set("limit", reset || !state.logsCursor ? "160" : "100");
  if (!reset && state.logsCursor) {
    params.set("cursor", state.logsCursor);
  }

  const payload = await request(`/api/runtime/logs?${params.toString()}`);
  renderLogs(payload, { append: !reset && Boolean(state.logsCursor) });
}
