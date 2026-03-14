import {
  dom,
  escapeHtml,
  formatCount,
  formatPercent,
  formatRate,
  formatShortTime,
  metricCard,
  request,
  setChartPlaceholder,
  setResourcesPlaceholder,
  showStatus,
  state,
} from "./shared.js";

const CHART_SERIES = [
  { key: "cpu_used_percent", label: "CPU", color: "#1d5c4d" },
  { key: "memory_used_percent", label: "内存", color: "#49866f" },
  { key: "disk_used_percent", label: "磁盘", color: "#c57a38" },
  { key: "load_ratio_percent", label: "负载", color: "#6a7b54" },
];

const RANGE_OPTIONS = [
  { key: "15m", label: "15 分钟" },
  { key: "1h", label: "1 小时" },
  { key: "6h", label: "6 小时" },
  { key: "24h", label: "24 小时" },
  { key: "7d", label: "7 天" },
];

function formatMetricPercent(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value >= 10) {
    return `${value.toFixed(0)}%`;
  }
  if (value >= 1) {
    return `${value.toFixed(1)}%`;
  }
  return `${value.toFixed(2)}%`;
}

function formatRawLoad(snapshot) {
  const load = snapshot?.load_average;
  if (!load) {
    return "-";
  }
  return `${load.one.toFixed(2)} / ${load.five.toFixed(2)} / ${load.fifteen.toFixed(2)}`;
}

function formatRollupValue(value) {
  return value === null || value === undefined ? "-" : formatMetricPercent(Number(value));
}

function parsePercent(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue;
  }
  const parsed = Number.parseFloat(String(rawValue).replace(/%$/, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function rangeLabel(rangeKey) {
  return RANGE_OPTIONS.find((item) => item.key === rangeKey)?.label || rangeKey;
}

function resolutionLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "-";
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} 小时`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} 分钟`;
  }
  return `${seconds} 秒`;
}

function buildFallbackHistory(snapshot) {
  const currentCpu = Number(snapshot?.cpu_used_percent ?? 0);
  const currentMemory = Number(snapshot?.memory?.used_percent ?? 0);
  const currentDisk = Number(snapshot?.root_disk?.used_percent ?? 0);
  const currentLoad = Number(snapshot?.load_ratio_percent ?? 0);
  const makeRollup = (value) => ({
    current: value,
    average_1m: null,
    average_5m: null,
  });
  return {
    interval_seconds: state.resourceSampleInterval || 5,
    resolution_seconds: state.resourceSampleInterval || 5,
    range_key: state.resourceRange,
    sampled_from: snapshot?.sampled_at || null,
    sampled_to: snapshot?.sampled_at || null,
    point_count: 0,
    points: [],
    summary: {
      cpu_used_percent: makeRollup(currentCpu),
      memory_used_percent: makeRollup(currentMemory),
      disk_used_percent: makeRollup(currentDisk),
      load_ratio_percent: makeRollup(currentLoad),
    },
  };
}

function renderRollupCard({ label, rollup, note, tone }) {
  const current = Number.isFinite(Number(rollup?.current)) ? Number(rollup.current) : null;
  return `
    <article class="metric-card ${escapeHtml(tone)} is-meter rollup-card">
      <div class="metric-body">
        <div class="metric-copy">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(formatRollupValue(current))}</strong>
          <small>${escapeHtml(note)}</small>
        </div>
        <div class="metric-ring" style="--percent:${Math.max(0, Math.min(100, current ?? 0))}">
          <span>${escapeHtml(formatRollupValue(current))}</span>
        </div>
      </div>
      <div class="rollup-strip">
        <div class="rollup-item">
          <span>当前</span>
          <strong>${escapeHtml(formatRollupValue(rollup?.current))}</strong>
        </div>
        <div class="rollup-item">
          <span>1m 均值</span>
          <strong>${escapeHtml(formatRollupValue(rollup?.average_1m))}</strong>
        </div>
        <div class="rollup-item">
          <span>5m 均值</span>
          <strong>${escapeHtml(formatRollupValue(rollup?.average_5m))}</strong>
        </div>
      </div>
    </article>
  `;
}

function isHealthyContainer(container) {
  const stateValue = String(container?.state || "").toLowerCase();
  const statusValue = String(container?.status || "").toLowerCase();
  if (
    stateValue.includes("exited")
    || stateValue.includes("dead")
    || statusValue.includes("unhealthy")
  ) {
    return false;
  }
  if (
    statusValue.includes("healthy")
    || stateValue === "running"
    || statusValue.startsWith("up ")
  ) {
    return true;
  }
  return false;
}

function summarizeDocker(docker) {
  const containers = Array.isArray(docker?.containers) ? docker.containers : [];
  const runningCount = Number.isFinite(Number(docker?.running_count))
    ? Number(docker.running_count)
    : containers.length;
  const healthyCount = containers.filter(isHealthyContainer).length;
  const averageCpu = average(containers.map((item) => parsePercent(item.cpu_percent)));
  const averageMemory = average(containers.map((item) => parsePercent(item.memory_percent)));
  return {
    available: Boolean(docker?.available),
    message: docker?.message || "",
    containers,
    runningCount,
    healthyCount,
    healthPercent: runningCount > 0 ? (healthyCount / runningCount) * 100 : 100,
    averageCpu,
    averageMemory,
  };
}

function renderDockerSection(docker) {
  const summary = summarizeDocker(docker);
  if (!summary.available) {
    return `
      <article class="detail-card">
        <div class="detail-head">
          <div>
            <h3>Docker 状态</h3>
            <p class="muted">实时读取本机 Docker 状态，用于区分容器不可用和面板采样延迟。</p>
          </div>
        </div>
        <div class="detail-empty">${escapeHtml(summary.message || "当前节点无法读取 Docker")}</div>
      </article>
    `;
  }

  return `
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>Docker 状态</h3>
          <p class="muted">显示当前运行容器的健康度，以及容器 CPU 和内存占用概况。</p>
        </div>
      </div>
      <div class="docker-overview">
        ${metricCard({
          label: "容器健康度",
          value: `${summary.healthyCount} / ${summary.runningCount || 0}`,
          note: "按当前运行容器的健康状态计算",
          meter: summary.healthPercent,
          tone: "tone-olive",
        })}
        ${metricCard({
          label: "容器 CPU",
          value: summary.averageCpu === null ? "-" : formatMetricPercent(summary.averageCpu),
          note: "运行容器当前 CPU 平均值",
          meter: summary.averageCpu,
          tone: "tone-accent",
        })}
        ${metricCard({
          label: "容器内存",
          value: summary.averageMemory === null ? "-" : formatMetricPercent(summary.averageMemory),
          note: "运行容器当前内存平均值",
          meter: summary.averageMemory,
          tone: "tone-green",
        })}
      </div>
      <div class="docker-list">
        ${
          summary.containers.length
            ? summary.containers
                .map(
                  (container) => `
                    <div class="docker-row">
                      <div class="docker-row-top">
                        <div class="docker-main">
                          <strong>${escapeHtml(container.name)}</strong>
                          <small>${escapeHtml(container.image)}</small>
                        </div>
                        <span class="docker-status ${isHealthyContainer(container) ? "is-healthy" : "is-warning"}">
                          ${escapeHtml(container.status || container.state || "-")}
                        </span>
                      </div>
                      <div class="docker-meta">
                        <span>CPU ${escapeHtml(container.cpu_percent || "-")}</span>
                        <span>内存 ${escapeHtml(container.memory_usage || "-")}</span>
                        ${
                          container.memory_percent
                            ? `<span>占比 ${escapeHtml(container.memory_percent)}</span>`
                            : ""
                        }
                        ${container.running_for ? `<span>${escapeHtml(container.running_for)}</span>` : ""}
                        ${container.network_io ? `<span>网络 ${escapeHtml(container.network_io)}</span>` : ""}
                        ${container.block_io ? `<span>磁盘 ${escapeHtml(container.block_io)}</span>` : ""}
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<div class="detail-empty">当前没有运行中的容器</div>`
        }
      </div>
    </article>
  `;
}

function renderNetworkSection(snapshot) {
  const interfaces = [...(snapshot.network_interfaces || [])].sort(
    (left, right) => right.download_bps + right.upload_bps - (left.download_bps + left.upload_bps)
  );
  return `
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>网卡</h3>
          <p class="muted">显示各网卡当前上下行速率，属于瞬时采样结果，不代表长周期平均吞吐。</p>
        </div>
      </div>
      <div class="detail-list">
        ${
          interfaces.length
            ? interfaces
                .map(
                  (item) => `
                    <div class="detail-row">
                      <strong>${escapeHtml(item.name)}</strong>
                      <span>下行 ${escapeHtml(formatRate(item.download_bps))}</span>
                      <span>上行 ${escapeHtml(formatRate(item.upload_bps))}</span>
                    </div>
                  `
                )
                .join("")
            : `<div class="detail-empty">当前没有可展示的网卡速率数据</div>`
        }
      </div>
    </article>
  `;
}

function renderDiskSection(snapshot) {
  const diskDevices = [...(snapshot.disk_devices || [])].sort(
    (left, right) => right.read_bps + right.write_bps - (left.read_bps + left.write_bps)
  );
  return `
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>磁盘</h3>
          <p class="muted">显示各块设备当前读写速率，属于瞬时采样结果，不代表持续吞吐能力。</p>
        </div>
      </div>
      <div class="detail-list">
        ${
          diskDevices.length
            ? diskDevices
                .map(
                  (item) => `
                    <div class="detail-row">
                      <strong>${escapeHtml(item.name)}</strong>
                      <span>读 ${escapeHtml(formatRate(item.read_bps))}</span>
                      <span>写 ${escapeHtml(formatRate(item.write_bps))}</span>
                    </div>
                  `
                )
                .join("")
            : `<div class="detail-empty">当前没有可展示的磁盘速率数据</div>`
        }
      </div>
    </article>
  `;
}

function renderResources(snapshot, historyPayload, docker) {
  const summary = historyPayload?.summary || buildFallbackHistory(snapshot).summary;
  const swap = snapshot.swap || { used_mb: 0, total_mb: 0, free_mb: 0, used_percent: null };
  const inode = snapshot.inode || {
    used: 0,
    total: 0,
    mount_point: snapshot.root_disk?.mount_point || "/",
    used_percent: null,
  };
  const processes = snapshot.processes || {
    total_processes: 0,
    tcp_connections: 0,
    established_connections: 0,
  };

  dom.resourcesEl.className = "resource-stack";
  dom.resourcesEl.innerHTML = `
    <section class="resource-section">
      <div class="resource-section-head">
        <div>
          <p class="section-kicker">Capacity</p>
          <h3>容量与健康</h3>
        </div>
        <p class="muted">卡片主值显示当前采样值，1m 和 5m 显示平滑均值，避免把单次尖峰误读为长期趋势。</p>
      </div>
      <div class="metric-grid metric-grid-ring">
        ${renderRollupCard({
          label: "CPU 利用率",
          rollup: summary.cpu_used_percent,
          note: `${snapshot.cpu_count} vCPU · 采样周期 ${historyPayload.interval_seconds} 秒`,
          tone: "tone-accent",
        })}
        ${renderRollupCard({
          label: "内存占用",
          rollup: summary.memory_used_percent,
          note: `${snapshot.memory.used_mb} / ${snapshot.memory.total_mb} MB`,
          tone: "tone-green",
        })}
        ${renderRollupCard({
          label: "磁盘占用",
          rollup: summary.disk_used_percent,
          note: `${snapshot.root_disk.used} / ${snapshot.root_disk.total} · ${snapshot.root_disk.mount_point}`,
          tone: "tone-amber",
        })}
        ${renderRollupCard({
          label: "系统负载",
          rollup: summary.load_ratio_percent,
          note: `原始 Load: ${formatRawLoad(snapshot)} · 已按 CPU 核数归一化`,
          tone: "tone-olive",
        })}
      </div>
    </section>

    <section class="resource-section">
      <div class="resource-section-head">
        <div>
          <p class="section-kicker">Runtime</p>
          <h3>运行概况</h3>
        </div>
        <p class="muted">这里集中显示主机信息、采样节奏和当前吞吐，便于快速判断是资源压力还是单次波动。</p>
      </div>
      <div class="metric-grid metric-grid-context">
        ${metricCard({
          label: "主机与运行时",
          value: snapshot.hostname,
          note: `${snapshot.uptime} · ${snapshot.cpu_count} vCPU`,
          tone: "tone-accent",
          cardClass: "metric-card-emphasis metric-card-span-2",
        })}
        ${metricCard({
          label: "进程 / 连接",
          value: `${formatCount(processes.total_processes)} / ${formatCount(processes.tcp_connections)}`,
          note: `已建立 ${formatCount(processes.established_connections)} 个 TCP 连接`,
          tone: "tone-accent",
        })}
        ${metricCard({
          label: "采样与趋势",
          value: `${historyPayload.interval_seconds} 秒采样`,
          note: `${rangeLabel(historyPayload.range_key)} 范围 · ${resolutionLabel(historyPayload.resolution_seconds)} 分辨率`,
          tone: "tone-olive",
        })}
        ${metricCard({
          label: "当前网络吞吐",
          value: `下行 ${formatRate(snapshot.network.download_bps)} / 上行 ${formatRate(snapshot.network.upload_bps)}`,
          note: "瞬时采样值，不做平滑平均",
          tone: "tone-green",
        })}
        ${metricCard({
          label: "当前磁盘 I/O",
          value: `读 ${formatRate(snapshot.disk_io.read_bps)} / 写 ${formatRate(snapshot.disk_io.write_bps)}`,
          note: "瞬时采样值，不做平滑平均",
          tone: "tone-amber",
        })}
        ${metricCard({
          label: "Swap / Inode",
          value: `${formatPercent(Number(swap.used_percent || 0))} / ${formatPercent(Number(inode.used_percent || 0))}`,
          note: `Swap ${swap.used_mb}/${swap.total_mb} MB · Inode ${formatCount(inode.used)}/${formatCount(inode.total)}`,
          tone: "tone-olive",
        })}
      </div>
    </section>
  `;

  dom.resourceBreakdownsEl.className = "resource-detail-grid";
  dom.resourceBreakdownsEl.innerHTML = `
    ${renderDockerSection(docker)}
    ${renderNetworkSection(snapshot)}
    ${renderDiskSection(snapshot)}
  `;
}

function renderLegend() {
  dom.chartLegendEl.innerHTML = CHART_SERIES.map(
    (series) => `
      <span class="legend-chip">
        <i style="background:${series.color}"></i>
        ${escapeHtml(series.label)}
      </span>
    `
  ).join("");
}

function renderResourceChart(payload) {
  const points = Array.isArray(payload?.points) ? payload.points : [];
  state.resourceSampleInterval = Number(payload?.interval_seconds) || state.resourceSampleInterval;
  state.resourceRange = payload?.range_key || state.resourceRange;
  syncRangeButtons();
  renderLegend();

  if (!points.length) {
    setChartPlaceholder("当前时间范围内还没有足够的历史样本");
    return;
  }

  const width = 980;
  const height = 300;
  const padding = { top: 18, right: 18, bottom: 34, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index) =>
    points.length === 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (points.length - 1)) * plotWidth;
  const y = (value) =>
    padding.top + ((100 - Math.max(0, Math.min(100, value))) / 100) * plotHeight;

  const gridValues = [0, 25, 50, 75, 100];
  const grid = gridValues
    .map(
      (value) => `
        <line x1="${padding.left}" y1="${y(value)}" x2="${width - padding.right}" y2="${y(value)}" />
        <text x="4" y="${y(value) + 4}">${value}%</text>
      `
    )
    .join("");

  const lines = CHART_SERIES.map((series) => {
    const polylinePoints = points
      .map((point, index) => {
        const value = Number.isFinite(Number(point?.[series.key])) ? Number(point[series.key]) : 0;
        return `${x(index)},${y(value)}`;
      })
      .join(" ");
    const lastPoint = points[points.length - 1];
    const lastValue = Number.isFinite(Number(lastPoint?.[series.key]))
      ? Number(lastPoint[series.key])
      : 0;
    return `
      <polyline fill="none" stroke="${series.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polylinePoints}" />
      <circle cx="${x(points.length - 1)}" cy="${y(lastValue)}" r="4.5" fill="${series.color}" />
    `;
  }).join("");

  const startLabel = formatShortTime(points[0].timestamp);
  const endLabel = formatShortTime(points[points.length - 1].timestamp);
  dom.chartRangeEl.textContent = `${rangeLabel(payload.range_key)} · ${payload.point_count} 点`;
  dom.chartCaptionEl.textContent = `当前查看 ${rangeLabel(payload.range_key)} 的趋势，原始采样 ${payload.interval_seconds} 秒，图表分辨率 ${resolutionLabel(payload.resolution_seconds)}`;
  dom.resourceChartEl.className = "chart";
  dom.resourceChartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="资源趋势图">
      <g class="chart-grid">${grid}</g>
      <g class="chart-lines">${lines}</g>
      <text class="chart-axis" x="${padding.left}" y="${height - 8}">${escapeHtml(startLabel)}</text>
      <text class="chart-axis" x="${width - padding.right}" y="${height - 8}" text-anchor="end">${escapeHtml(endLabel)}</text>
    </svg>
  `;
}

function syncRangeButtons() {
  dom.resourceRangeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.range === state.resourceRange);
  });
}

async function switchRange(rangeKey) {
  if (!rangeKey || rangeKey === state.resourceRange) {
    return;
  }
  state.resourceRange = rangeKey;
  syncRangeButtons();
  try {
    await loadResourcesSection();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

dom.resourceRangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    void switchRange(button.dataset.range);
  });
});

export async function loadResourcesSection({ forceRefresh = false } = {}) {
  const historyPath = `/api/resources/history?range=${encodeURIComponent(state.resourceRange)}`;
  const [snapshotResult, historyResult, dockerResult] = await Promise.allSettled([
    request(`/api/resources${forceRefresh ? "?fresh=true" : ""}`),
    request(historyPath),
    request("/api/runtime/docker"),
  ]);

  if (snapshotResult.status !== "fulfilled") {
    state.resourcesLoaded = false;
    setResourcesPlaceholder(snapshotResult.reason.message);
    throw snapshotResult.reason;
  }

  const historyPayload =
    historyResult.status === "fulfilled"
      ? historyResult.value
      : buildFallbackHistory(snapshotResult.value);

  state.resourcesLoaded = true;
  renderResources(
    snapshotResult.value,
    historyPayload,
    dockerResult.status === "fulfilled" ? dockerResult.value : null
  );

  if (historyResult.status === "fulfilled") {
    renderResourceChart(historyResult.value);
  } else {
    renderResourceChart(historyPayload);
  }

  if (dockerResult.status === "rejected") {
    state.docker = null;
  } else {
    state.docker = dockerResult.value;
  }
}
