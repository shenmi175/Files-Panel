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

function detailRows(items, renderRow) {
  if (!items.length) {
    return `<div class="detail-empty">暂无采样数据</div>`;
  }
  return items.map(renderRow).join("");
}

function renderDockerCard(docker) {
  if (!docker?.available) {
    return `
      <article class="detail-card detail-card-docker">
        <div class="detail-head">
          <div>
            <h3>Docker 状态</h3>
            <p class="muted">当前服务器上的运行中容器</p>
          </div>
        </div>
        <div class="detail-empty">${escapeHtml(docker?.message || "docker 当前不可用")}</div>
      </article>
    `;
  }

  if (!docker.containers.length) {
    return `
      <article class="detail-card detail-card-docker">
        <div class="detail-head">
          <div>
            <h3>Docker 状态</h3>
            <p class="muted">当前服务器上的运行中容器</p>
          </div>
        </div>
        <div class="detail-empty">${escapeHtml(docker.message || "当前没有运行中的容器")}</div>
      </article>
    `;
  }

  return `
    <article class="detail-card detail-card-docker">
      <div class="detail-head">
        <div>
          <h3>Docker 状态</h3>
          <p class="muted">共 ${escapeHtml(String(docker.running_count))} 个运行中容器</p>
        </div>
      </div>
      <div class="docker-list">
        ${docker.containers
          .map(
            (container) => `
              <div class="docker-row">
                <div class="docker-main">
                  <strong>${escapeHtml(container.name)}</strong>
                  <small>${escapeHtml(container.image)}</small>
                </div>
                <div class="docker-meta">
                  <span>${escapeHtml(container.status)}</span>
                  <span>CPU ${escapeHtml(container.cpu_percent || "-")}</span>
                  <span>内存 ${escapeHtml(container.memory_usage || "-")}</span>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
      ${
        docker.message
          ? `<p class="muted footnote-inline">${escapeHtml(docker.message)}</p>`
          : ""
      }
    </article>
  `;
}

function renderResourceBreakdowns(snapshot, docker) {
  const interfaces = [...(snapshot.network_interfaces || [])].sort(
    (left, right) => right.download_bps + right.upload_bps - (left.download_bps + left.upload_bps)
  );
  const diskDevices = [...(snapshot.disk_devices || [])].sort(
    (left, right) => right.read_bps + right.write_bps - (left.read_bps + left.write_bps)
  );

  dom.resourceBreakdownsEl.className = "resource-detail-grid";
  dom.resourceBreakdownsEl.innerHTML = `
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>网卡分项</h3>
          <p class="muted">按网卡展示实时上下行速率</p>
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
          `
        )}
      </div>
    </article>
    ${renderDockerCard(docker)}
    <article class="detail-card">
      <div class="detail-head">
        <div>
          <h3>磁盘分项</h3>
          <p class="muted">按块设备展示实时读写速率</p>
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
          `
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
      ? parseFloat(snapshot.root_disk.used_percent)
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
  const dockerSummary = docker?.available
    ? docker.running_count > 0
      ? `${docker.running_count} 个运行中容器`
      : "未检测到运行中的容器"
    : docker?.message || "docker 不可用";
  const dockerNote =
    docker?.available && docker.containers?.length
      ? docker.containers
          .slice(0, 2)
          .map((item) => item.name)
          .join(" · ")
      : "容器运行态已并入资源页";

  dom.resourcesEl.className = "resource-stack";
  dom.resourcesEl.innerHTML = `
    <div class="metric-grid metric-grid-priority">
      ${[
        metricCard({
          label: "主机与运行时",
          value: snapshot.hostname,
          note: `${snapshot.uptime} · ${cpuCount ? `${cpuCount} vCPU` : "等待 CPU 信息"}`,
          tone: "tone-accent",
        }),
        metricCard({
          label: "CPU 利用率",
          value: cpuUsedPercent === null ? "等待采样" : formatPercent(cpuUsedPercent),
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
              ? `${snapshot.root_disk.mount_point} · 占比待刷新`
              : `${snapshot.root_disk.mount_point} · ${formatPercent(diskUsedPercent)}`,
          meter: diskUsedPercent,
          tone: "tone-amber",
        }),
        metricCard({
          label: "Docker",
          value: dockerSummary,
          note: dockerNote,
          tone: "tone-olive",
        }),
      ].join("")}
    </div>
    <div class="metric-grid metric-grid-support">
      ${[
        metricCard({
          label: "Load",
          value: `${snapshot.load_average.one.toFixed(2)} / ${snapshot.load_average.five.toFixed(2)} / ${snapshot.load_average.fifteen.toFixed(2)}`,
          note:
            loadRatioPercent === null
              ? "1m / 5m / 15m，占比待刷新"
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
          label: "网络吞吐",
          value: `↓ ${formatRate(downloadRate)} / ↑ ${formatRate(uploadRate)}`,
          note: "全网卡聚合实时速率",
          tone: "tone-green",
        }),
        metricCard({
          label: "磁盘 I/O",
          value: `读 ${formatRate(diskReadRate)} / 写 ${formatRate(diskWriteRate)}`,
          note: "块设备聚合实时速率",
          tone: "tone-amber",
        }),
        metricCard({
          label: "Inode",
          value: `${formatCount(inode.used)} / ${formatCount(inode.total)}`,
          note: `${inode.mount_point} · 文件节点占用`,
          meter: inodeUsedPercent,
          tone: "tone-green",
        }),
        metricCard({
          label: "进程 / 连接",
          value: `${formatCount(processCount)} / ${formatCount(tcpConnectionCount)}`,
          note: `总进程 / TCP 连接，已建立 ${formatCount(establishedCount)}`,
          tone: "tone-accent",
        }),
      ].join("")}
    </div>
  `;

  state.docker = docker;
  renderResourceBreakdowns(snapshot, docker);
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
    setChartPlaceholder("暂无趋势数据");
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
    renderResources(
      snapshotResult.value,
      dockerResult.status === "fulfilled" ? dockerResult.value : null
    );
  } else {
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
