import {
  dom,
  escapeHtml,
  formatCount,
  formatPercent,
  formatRate,
  metricCard,
  normalizeFeatureError,
  request,
  setChartPlaceholder,
  setResourcesPlaceholder,
  state,
} from "./shared.js";

const CHART_SERIES = [
  { key: "cpu_used_percent", label: "CPU", color: "#1d5c4d" },
  { key: "memory_used_percent", label: "内存", color: "#49866f" },
  { key: "disk_used_percent", label: "磁盘", color: "#c57a38" },
  { key: "load_ratio_percent", label: "负载", color: "#6a7b54" },
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

function parsePercentValue(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue;
  }
  const normalized = String(rawValue).trim().replace(/%$/, "");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function safeAverage(values) {
  const numericValues = values.filter((value) => Number.isFinite(value));
  if (!numericValues.length) {
    return null;
  }
  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
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
  const avgCpuPercent = safeAverage(
    containers.map((container) => parsePercentValue(container.cpu_percent))
  );
  const avgMemoryPercent = safeAverage(
    containers.map((container) => parsePercentValue(container.memory_percent))
  );
  const healthPercent = runningCount > 0 ? (healthyCount / runningCount) * 100 : 100;

  return {
    available: Boolean(docker?.available),
    containers,
    runningCount,
    healthyCount,
    avgCpuPercent,
    avgMemoryPercent,
    healthPercent,
    message: docker?.message || "",
  };
}

function detailRows(items, renderRow, emptyMessage) {
  if (!items.length) {
    return `<div class="detail-empty">${escapeHtml(emptyMessage)}</div>`;
  }
  return items.map(renderRow).join("");
}

function dockerStatusTone(container) {
  return isHealthyContainer(container) ? "is-healthy" : "is-warning";
}

function renderMiniRing({ label, value, note, meter, toneClass = "" }) {
  const boundedMeter = Number.isFinite(meter) ? Math.max(0, Math.min(100, meter)) : 0;
  const ringLabel = Number.isFinite(meter) ? formatMetricPercent(meter) : "N/A";
  return `
    <div class="docker-mini-card">
      <div class="docker-mini-copy">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(note)}</small>
      </div>
      <div class="metric-ring metric-ring-sm ${escapeHtml(toneClass)}" style="--percent:${boundedMeter}">
        <span>${escapeHtml(ringLabel)}</span>
      </div>
    </div>
  `;
}

function renderDockerCard(dockerSummary) {
  if (!dockerSummary.available) {
    return `
      <article class="detail-card detail-card-docker">
        <div class="detail-head">
          <div>
            <h3>Docker 状态</h3>
            <p class="muted">每 ${state.resourceSampleInterval} 秒随概览自动刷新，也可以手动点右上角刷新。</p>
          </div>
        </div>
        <div class="detail-empty">${escapeHtml(dockerSummary.message || "当前节点无法访问 Docker。")}</div>
      </article>
    `;
  }

  if (!dockerSummary.containers.length) {
    return `
      <article class="detail-card detail-card-docker">
        <div class="detail-head">
          <div>
            <h3>Docker 状态</h3>
            <p class="muted">每 ${state.resourceSampleInterval} 秒随概览自动刷新，也可以手动点右上角刷新。</p>
          </div>
        </div>
        <div class="docker-overview">
          ${renderMiniRing({
            label: "健康度",
            value: "0 个容器",
            note: "当前没有运行中的容器",
            meter: 100,
            toneClass: "tone-olive",
          })}
          ${renderMiniRing({
            label: "平均 CPU",
            value: "-",
            note: "暂无采样数据",
            meter: 0,
            toneClass: "tone-accent",
          })}
          ${renderMiniRing({
            label: "平均内存",
            value: "-",
            note: "暂无采样数据",
            meter: 0,
            toneClass: "tone-green",
          })}
        </div>
        <div class="detail-empty">${escapeHtml(dockerSummary.message || "当前节点没有运行中的 Docker 容器。")}</div>
      </article>
    `;
  }

  return `
    <article class="detail-card detail-card-docker">
      <div class="detail-head">
        <div>
          <h3>Docker 状态</h3>
          <p class="muted">每 ${state.resourceSampleInterval} 秒随概览自动刷新，也可以手动点右上角刷新。</p>
        </div>
      </div>
      <div class="docker-overview">
        ${renderMiniRing({
          label: "健康度",
          value: `${dockerSummary.healthyCount} / ${dockerSummary.runningCount}`,
          note: "按运行状态和健康检查汇总",
          meter: dockerSummary.healthPercent,
          toneClass: "tone-olive",
        })}
        ${renderMiniRing({
          label: "平均 CPU",
          value:
            dockerSummary.avgCpuPercent === null
              ? "-"
              : formatMetricPercent(dockerSummary.avgCpuPercent),
          note: "运行中容器的实时 CPU 平均值",
          meter: dockerSummary.avgCpuPercent,
          toneClass: "tone-accent",
        })}
        ${renderMiniRing({
          label: "平均内存",
          value:
            dockerSummary.avgMemoryPercent === null
              ? "-"
              : formatMetricPercent(dockerSummary.avgMemoryPercent),
          note: "运行中容器的实时内存平均值",
          meter: dockerSummary.avgMemoryPercent,
          toneClass: "tone-green",
        })}
      </div>
      <div class="docker-list">
        ${dockerSummary.containers
          .map((container) => {
            const cpuPercent = parsePercentValue(container.cpu_percent);
            const memoryPercent = parsePercentValue(container.memory_percent);
            return `
              <div class="docker-row">
                <div class="docker-row-top">
                  <div class="docker-main">
                    <strong>${escapeHtml(container.name)}</strong>
                    <small>${escapeHtml(container.image)}</small>
                  </div>
                  <span class="docker-status ${dockerStatusTone(container)}">${escapeHtml(container.status || container.state || "-")}</span>
                </div>
                <div class="docker-stat-grid">
                  ${renderMiniRing({
                    label: "CPU",
                    value: container.cpu_percent || "-",
                    note: container.network_io || "无网络统计",
                    meter: cpuPercent,
                    toneClass: "tone-accent",
                  })}
                  ${renderMiniRing({
                    label: "内存",
                    value: container.memory_usage || "-",
                    note: container.memory_percent || "无内存占比",
                    meter: memoryPercent,
                    toneClass: "tone-green",
                  })}
                </div>
                <div class="docker-meta">
                  ${
                    container.running_for
                      ? `<span>已运行 ${escapeHtml(container.running_for)}</span>`
                      : ""
                  }
                  ${container.block_io ? `<span>块 I/O ${escapeHtml(container.block_io)}</span>` : ""}
                  ${container.ports ? `<span>端口 ${escapeHtml(container.ports)}</span>` : ""}
                  ${container.pids ? `<span>PIDs ${escapeHtml(container.pids)}</span>` : ""}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
      ${
        dockerSummary.message
          ? `<p class="muted footnote-inline">${escapeHtml(dockerSummary.message)}</p>`
          : ""
      }
    </article>
  `;
}

function renderResourceBreakdowns(snapshot, dockerSummary) {
  const interfaces = [...(snapshot.network_interfaces || [])].sort(
    (left, right) => right.download_bps + right.upload_bps - (left.download_bps + left.upload_bps)
  );
  const diskDevices = [...(snapshot.disk_devices || [])].sort(
    (left, right) => right.read_bps + right.write_bps - (left.read_bps + left.write_bps)
  );

  dom.resourceBreakdownsEl.className = "resource-detail-grid";
  dom.resourceBreakdownsEl.innerHTML = `
    ${renderDockerCard(dockerSummary)}
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>网卡</h3>
          <p class="muted">按网卡展示当前节点的实时上下行速率。</p>
        </div>
      </div>
      <div class="detail-list">
        ${detailRows(
          interfaces,
          (item) => `
            <div class="detail-row">
              <strong>${escapeHtml(item.name)}</strong>
              <span>↓ ${escapeHtml(formatRate(item.download_bps))}</span>
              <span>↑ ${escapeHtml(formatRate(item.upload_bps))}</span>
            </div>
          `,
          "当前没有可展示的网卡采样。"
        )}
      </div>
    </article>
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>磁盘</h3>
          <p class="muted">按块设备展示当前节点的实时读写速率。</p>
        </div>
      </div>
      <div class="detail-list">
        ${detailRows(
          diskDevices,
          (item) => `
            <div class="detail-row">
              <strong>${escapeHtml(item.name)}</strong>
              <span>读 ${escapeHtml(formatRate(item.read_bps))}</span>
              <span>写 ${escapeHtml(formatRate(item.write_bps))}</span>
            </div>
          `,
          "当前没有可展示的磁盘设备采样。"
        )}
      </div>
    </article>
  `;
}

export function renderResources(snapshot, docker) {
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
  const cpuCount = Number.isFinite(Number(snapshot.cpu_count)) ? Number(snapshot.cpu_count) : null;
  const cpuUsedPercent = Number.isFinite(Number(snapshot.cpu_used_percent))
    ? Number(snapshot.cpu_used_percent)
    : null;
  const loadRatioPercent = Number.isFinite(Number(snapshot.load_ratio_percent))
    ? Number(snapshot.load_ratio_percent)
    : null;
  const memoryUsedPercent = Number.isFinite(snapshot.memory?.used_percent)
    ? snapshot.memory.used_percent
    : snapshot.memory?.total_mb
      ? (snapshot.memory.used_mb / snapshot.memory.total_mb) * 100
      : null;
  const diskPercentValue =
    typeof snapshot.root_disk?.used_percent === "string"
      ? Number.parseFloat(snapshot.root_disk.used_percent)
      : snapshot.root_disk?.used_percent;
  const diskUsedPercent = Number.isFinite(diskPercentValue) ? Number(diskPercentValue) : null;
  const downloadRate = Number.isFinite(Number(snapshot.network?.download_bps))
    ? Number(snapshot.network.download_bps)
    : 0;
  const uploadRate = Number.isFinite(Number(snapshot.network?.upload_bps))
    ? Number(snapshot.network.upload_bps)
    : 0;
  const diskReadRate = Number.isFinite(Number(snapshot.disk_io?.read_bps))
    ? Number(snapshot.disk_io.read_bps)
    : 0;
  const diskWriteRate = Number.isFinite(Number(snapshot.disk_io?.write_bps))
    ? Number(snapshot.disk_io.write_bps)
    : 0;
  const swapUsedPercent = Number.isFinite(Number(swap.used_percent)) ? Number(swap.used_percent) : null;
  const inodeUsedPercent = Number.isFinite(Number(inode.used_percent)) ? Number(inode.used_percent) : null;
  const processCount = Number.isFinite(Number(processes.total_processes))
    ? Number(processes.total_processes)
    : 0;
  const tcpConnectionCount = Number.isFinite(Number(processes.tcp_connections))
    ? Number(processes.tcp_connections)
    : 0;
  const establishedCount = Number.isFinite(Number(processes.established_connections))
    ? Number(processes.established_connections)
    : 0;
  const dockerSummary = summarizeDocker(docker);
  const dockerMetricValue = dockerSummary.available
    ? dockerSummary.runningCount > 0
      ? `${dockerSummary.runningCount} 个运行中`
      : "没有运行中的容器"
    : dockerSummary.message || "Docker 当前不可用";
  const dockerMetricNote = dockerSummary.available
    ? `健康 ${dockerSummary.healthyCount}/${dockerSummary.runningCount || 0} · 平均 CPU ${
        dockerSummary.avgCpuPercent === null
          ? "-"
          : formatMetricPercent(dockerSummary.avgCpuPercent)
      } · 每 ${state.resourceSampleInterval} 秒刷新`
    : "请检查 Docker 服务、权限或 docker.sock 访问状态";
  const dockerMeter = dockerSummary.available ? dockerSummary.healthPercent : 0;
  const dockerMeterLabel = dockerSummary.available
    ? `${dockerSummary.healthyCount}/${dockerSummary.runningCount || 0}`
    : "OFF";

  dom.resourcesEl.className = "resource-stack";
  dom.resourcesEl.innerHTML = `
    <section class="resource-section">
      <div class="resource-section-head">
        <div>
          <p class="section-kicker">Health</p>
          <h3>容量与健康</h3>
        </div>
        <p class="muted">环形指标集中显示资源占用和 Docker 健康度，便于先确认当前节点负载。</p>
      </div>
      <div class="metric-grid metric-grid-ring">
        ${[
          metricCard({
            label: "CPU 利用率",
            value: cpuUsedPercent === null ? "暂无数据" : formatPercent(cpuUsedPercent),
            note: cpuCount ? `${cpuCount} vCPU · 实时利用率` : "CPU 实时利用率",
            meter: cpuUsedPercent,
            tone: "tone-accent",
          }),
          metricCard({
            label: "内存",
            value: `${snapshot.memory.used_mb} / ${snapshot.memory.total_mb} MB`,
            note: `available ${snapshot.memory.available_mb} MB`,
            meter: memoryUsedPercent,
            tone: "tone-green",
          }),
          metricCard({
            label: "磁盘",
            value: `${snapshot.root_disk.used} / ${snapshot.root_disk.total}`,
            note:
              diskUsedPercent === null
                ? `${snapshot.root_disk.mount_point} · 暂无占用率`
                : `${snapshot.root_disk.mount_point} · ${formatPercent(diskUsedPercent)}`,
            meter: diskUsedPercent,
            tone: "tone-amber",
          }),
          metricCard({
            label: "Docker 健康度",
            value: dockerMetricValue,
            note: dockerMetricNote,
            meter: dockerMeter,
            meterLabel: dockerMeterLabel,
            tone: "tone-olive",
          }),
          metricCard({
            label: "Load",
            value: `${snapshot.load_average.one.toFixed(2)} / ${snapshot.load_average.five.toFixed(2)} / ${snapshot.load_average.fifteen.toFixed(2)}`,
            note:
              loadRatioPercent === null
                ? "1m / 5m / 15m 负载比"
                : `1m / 5m / 15m，当前约 ${formatPercent(loadRatioPercent)}`,
            meter: loadRatioPercent,
            tone: "tone-olive",
          }),
          metricCard({
            label: "Swap",
            value: `${swap.used_mb} / ${swap.total_mb} MB`,
            note: `free ${swap.free_mb} MB`,
            meter: swapUsedPercent,
            tone: "tone-olive",
          }),
          metricCard({
            label: "Inode",
            value: `${formatCount(inode.used)} / ${formatCount(inode.total)}`,
            note: `${inode.mount_point} · 文件节点占用`,
            meter: inodeUsedPercent,
            tone: "tone-green",
          }),
        ].join("")}
      </div>
    </section>
    <section class="resource-section">
      <div class="resource-section-head">
        <div>
          <p class="section-kicker">Context</p>
          <h3>运行概况</h3>
        </div>
        <p class="muted">文字卡片单独放大，用来快速判断主机状态、连接数和实时吞吐。</p>
      </div>
      <div class="metric-grid metric-grid-context">
        ${[
          metricCard({
            label: "主机与运行时",
            value: snapshot.hostname,
            note: `${snapshot.uptime} · ${cpuCount ? `${cpuCount} vCPU` : "CPU 信息暂缺"}`,
            tone: "tone-accent",
            cardClass: "metric-card-emphasis metric-card-span-2",
          }),
          metricCard({
            label: "进程 / 连接",
            value: `${formatCount(processCount)} / ${formatCount(tcpConnectionCount)}`,
            note: `已建立 TCP ${formatCount(establishedCount)}`,
            tone: "tone-accent",
          }),
          metricCard({
            label: "采样节奏",
            value: `每 ${state.resourceSampleInterval} 秒`,
            note: "Docker 与资源概览按同一节奏自动刷新",
            tone: "tone-olive",
          }),
          metricCard({
            label: "全网吞吐",
            value: `↓ ${formatRate(downloadRate)} / ↑ ${formatRate(uploadRate)}`,
            note: "汇总全部网卡的实时上下行速率",
            tone: "tone-green",
          }),
          metricCard({
            label: "磁盘 I/O",
            value: `读 ${formatRate(diskReadRate)} / 写 ${formatRate(diskWriteRate)}`,
            note: "汇总全部块设备的实时读写速率",
            tone: "tone-amber",
          }),
        ].join("")}
      </div>
    </section>
  `;

  state.docker = docker;
  renderResourceBreakdowns(snapshot, dockerSummary);
}

export function renderResourceChart(payload) {
  const points = payload.points || [];
  state.resourceSampleInterval = Number(payload.interval_seconds) || state.resourceSampleInterval;
  dom.chartLegendEl.innerHTML = CHART_SERIES.map(
    (series) => `
      <span class="legend-chip">
        <i style="background:${series.color}"></i>
        ${escapeHtml(series.label)}
      </span>
    `
  ).join("");

  if (!points.length) {
    setChartPlaceholder("当前还没有足够的历史采样点。");
    return;
  }

  const width = 960;
  const height = 280;
  const padding = { top: 18, right: 16, bottom: 32, left: 30 };
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
        <text x="2" y="${y(value) + 4}">${value}%</text>
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

  const startLabel = new Date(points[0].timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const endLabel = new Date(points[points.length - 1].timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  dom.chartRangeEl.textContent = `最近 ${points.length} 个采样点 · 每 ${payload.interval_seconds} 秒`;
  dom.chartCaptionEl.textContent = `${startLabel} - ${endLabel}`;
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

export async function loadResourcesSection({ forceRefresh = false } = {}) {
  const [snapshotResult, historyResult, dockerResult] = await Promise.allSettled([
    request(`/api/resources${forceRefresh ? "?fresh=true" : ""}`),
    request("/api/resources/history"),
    request("/api/runtime/docker"),
  ]);

  if (snapshotResult.status === "fulfilled") {
    state.resourcesLoaded = true;
    renderResources(
      snapshotResult.value,
      dockerResult.status === "fulfilled" ? dockerResult.value : null
    );
  } else {
    state.resourcesLoaded = false;
    setResourcesPlaceholder(snapshotResult.reason.message);
    throw snapshotResult.reason;
  }

  if (historyResult.status === "fulfilled") {
    renderResourceChart(historyResult.value);
  } else {
    setChartPlaceholder(normalizeFeatureError(historyResult.reason, "资源趋势"));
  }

  if (dockerResult.status === "rejected") {
    state.docker = null;
  }
}
