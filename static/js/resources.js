import {
  dom,
  escapeHtml,
  formatCount,
  formatPercent,
  formatRate,
  formatShortTime,
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

const CHART_WIDTH = 980;
const CHART_HEIGHT = 300;
const CHART_PADDING = { top: 18, right: 18, bottom: 34, left: 34 };
let resourcesScaffoldReady = false;
let chartScaffoldReady = false;
let breakdownScaffoldReady = false;
let latestResourceSnapshot = null;
let latestDockerStatus = null;
let resourceRequestEpoch = 0;

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

function setText(node, value) {
  if (!node) {
    return;
  }
  const nextValue = String(value ?? "");
  if (node.textContent !== nextValue) {
    node.textContent = nextValue;
  }
}

function setStyleVariable(node, name, value) {
  if (!node) {
    return;
  }
  const nextValue = String(value);
  if (node.style.getPropertyValue(name) !== nextValue) {
    node.style.setProperty(name, nextValue);
  }
}

function setInnerHTML(node, value) {
  if (!node) {
    return;
  }
  const nextValue = String(value ?? "");
  if (node.innerHTML !== nextValue) {
    node.innerHTML = nextValue;
  }
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0));
}

function buildRollupCards(snapshot, historyPayload, summary) {
  return [
    {
      key: "cpu",
      label: "CPU 利用率",
      tone: "tone-accent",
      note: `${snapshot.cpu_count} vCPU · 采样周期 ${historyPayload.interval_seconds} 秒`,
      rollup: summary.cpu_used_percent,
    },
    {
      key: "memory",
      label: "内存占用",
      tone: "tone-green",
      note: `${snapshot.memory.used_mb} / ${snapshot.memory.total_mb} MB`,
      rollup: summary.memory_used_percent,
    },
    {
      key: "disk",
      label: "磁盘占用",
      tone: "tone-amber",
      note: `${snapshot.root_disk.used} / ${snapshot.root_disk.total} · ${snapshot.root_disk.mount_point}`,
      rollup: summary.disk_used_percent,
    },
    {
      key: "load",
      label: "系统负载",
      tone: "tone-olive",
      note: `原始 Load: ${formatRawLoad(snapshot)} · 已按 CPU 核数归一化`,
      rollup: summary.load_ratio_percent,
    },
  ].map((card) => {
    const current = Number.isFinite(Number(card.rollup?.current)) ? Number(card.rollup.current) : null;
    return {
      ...card,
      value: formatRollupValue(current),
      current: formatRollupValue(card.rollup?.current),
      average1m: formatRollupValue(card.rollup?.average_1m),
      average5m: formatRollupValue(card.rollup?.average_5m),
      percent: clampPercent(current),
    };
  });
}

function buildRuntimeCards(snapshot, historyPayload, swap, inode, processes) {
  return [
    {
      key: "host",
      label: "主机与运行时",
      value: snapshot.hostname,
      note: `${snapshot.uptime} · ${snapshot.cpu_count} vCPU`,
      tone: "tone-accent",
      cardClass: "metric-card-emphasis metric-card-span-2",
    },
    {
      key: "processes",
      label: "进程 / 连接",
      value: `${formatCount(processes.total_processes)} / ${formatCount(processes.tcp_connections)}`,
      note: `已建立 ${formatCount(processes.established_connections)} 个 TCP 连接`,
      tone: "tone-accent",
      cardClass: "",
    },
    {
      key: "sampling",
      label: "采样与趋势",
      value: `${historyPayload.interval_seconds} 秒采样`,
      note: `${rangeLabel(historyPayload.range_key)} 范围 · ${resolutionLabel(historyPayload.resolution_seconds)} 分辨率`,
      tone: "tone-olive",
      cardClass: "",
    },
    {
      key: "network",
      label: "当前网络吞吐",
      value: `下行 ${formatRate(snapshot.network.download_bps)} / 上行 ${formatRate(snapshot.network.upload_bps)}`,
      note: "瞬时采样值，不做平滑平均",
      tone: "tone-green",
      cardClass: "",
    },
    {
      key: "disk-io",
      label: "当前磁盘 I/O",
      value: `读 ${formatRate(snapshot.disk_io.read_bps)} / 写 ${formatRate(snapshot.disk_io.write_bps)}`,
      note: "瞬时采样值，不做平滑平均",
      tone: "tone-amber",
      cardClass: "",
    },
    {
      key: "swap",
      label: "Swap / Inode",
      value: `${formatPercent(Number(swap.used_percent || 0))} / ${formatPercent(Number(inode.used_percent || 0))}`,
      note: `Swap ${swap.used_mb}/${swap.total_mb} MB · Inode ${formatCount(inode.used)}/${formatCount(inode.total)}`,
      tone: "tone-olive",
      cardClass: "",
    },
  ];
}

function renderRollupCardMarkup(card) {
  return `
    <article class="metric-card ${escapeHtml(card.tone)} is-meter rollup-card" data-rollup-card="${escapeHtml(card.key)}">
      <div class="metric-body">
        <div class="metric-copy">
          <span>${escapeHtml(card.label)}</span>
          <strong data-role="value">${escapeHtml(card.value)}</strong>
          <small data-role="note">${escapeHtml(card.note)}</small>
        </div>
        <div class="metric-ring" data-role="ring" style="--percent:${card.percent}">
          <span data-role="ring-label">${escapeHtml(card.value)}</span>
        </div>
      </div>
      <div class="rollup-strip">
        <div class="rollup-item">
          <span>当前</span>
          <strong data-role="current">${escapeHtml(card.current)}</strong>
        </div>
        <div class="rollup-item">
          <span>1m</span>
          <strong data-role="average-1m">${escapeHtml(card.average1m)}</strong>
        </div>
        <div class="rollup-item">
          <span>5m</span>
          <strong data-role="average-5m">${escapeHtml(card.average5m)}</strong>
        </div>
      </div>
    </article>
  `;
}

function renderRuntimeCardMarkup(card) {
  return `
    <div class="metric-card ${escapeHtml(card.tone)} is-text ${escapeHtml(card.cardClass)}" data-runtime-card="${escapeHtml(card.key)}">
      <div class="metric-body">
        <div class="metric-copy">
          <span>${escapeHtml(card.label)}</span>
          <strong data-role="value">${escapeHtml(card.value)}</strong>
          <small data-role="note">${escapeHtml(card.note)}</small>
        </div>
      </div>
    </div>
  `;
}

function ensureResourcesScaffold(rollupCards, runtimeCards) {
  if (
    resourcesScaffoldReady
    && dom.resourcesEl.querySelectorAll("[data-rollup-card]").length === rollupCards.length
    && dom.resourcesEl.querySelectorAll("[data-runtime-card]").length === runtimeCards.length
  ) {
    return;
  }

  dom.resourcesEl.className = "resource-stack";
  dom.resourcesEl.innerHTML = `
    <section class="resource-section">
      <div class="resource-section-head">
        <div>
          <p class="section-kicker">Capacity</p>
          <h3>容量与健康</h3>
        </div>
      </div>
      <div class="metric-grid metric-grid-ring">
        ${rollupCards.map(renderRollupCardMarkup).join("")}
      </div>
    </section>

    <section class="resource-section">
      <div class="resource-section-head">
        <div>
          <p class="section-kicker">Runtime</p>
          <h3>运行概况</h3>
        </div>
      </div>
      <div class="metric-grid metric-grid-context">
        ${runtimeCards.map(renderRuntimeCardMarkup).join("")}
      </div>
    </section>
  `;
  resourcesScaffoldReady = true;
}

function patchResources(rollupCards, runtimeCards) {
  ensureResourcesScaffold(rollupCards, runtimeCards);
  dom.resourcesEl.className = "resource-stack";

  rollupCards.forEach((card) => {
    const cardEl = dom.resourcesEl.querySelector(`[data-rollup-card="${card.key}"]`);
    if (!cardEl) {
      return;
    }
    setText(cardEl.querySelector('[data-role="value"]'), card.value);
    setText(cardEl.querySelector('[data-role="note"]'), card.note);
    setText(cardEl.querySelector('[data-role="ring-label"]'), card.value);
    setText(cardEl.querySelector('[data-role="current"]'), card.current);
    setText(cardEl.querySelector('[data-role="average-1m"]'), card.average1m);
    setText(cardEl.querySelector('[data-role="average-5m"]'), card.average5m);
    setStyleVariable(cardEl.querySelector('[data-role="ring"]'), "--percent", card.percent);
  });

  runtimeCards.forEach((card) => {
    const cardEl = dom.resourcesEl.querySelector(`[data-runtime-card="${card.key}"]`);
    if (!cardEl) {
      return;
    }
    setText(cardEl.querySelector('[data-role="value"]'), card.value);
    setText(cardEl.querySelector('[data-role="note"]'), card.note);
  });
}

function renderSummaryMeterCardMarkup(card) {
  return `
    <div class="metric-card ${escapeHtml(card.tone)} is-meter" data-summary-card="${escapeHtml(card.key)}">
      <div class="metric-body">
        <div class="metric-copy">
          <span>${escapeHtml(card.label)}</span>
          <strong data-role="value">-</strong>
          <small data-role="note"></small>
        </div>
        <div class="metric-ring" data-role="ring" style="--percent:0">
          <span data-role="ring-label">-</span>
        </div>
      </div>
    </div>
  `;
}

function ensureBreakdownScaffold() {
  if (
    breakdownScaffoldReady
    && dom.resourceBreakdownsEl.querySelector('[data-breakdown="docker"]')
    && dom.resourceBreakdownsEl.querySelector('[data-breakdown="network"]')
    && dom.resourceBreakdownsEl.querySelector('[data-breakdown="disk"]')
  ) {
    return;
  }

  dom.resourceBreakdownsEl.className = "resource-detail-grid";
  dom.resourceBreakdownsEl.innerHTML = `
    <article class="detail-card" data-breakdown="docker">
      <div class="detail-head">
        <div>
          <h3>Docker 状态</h3>
          <p class="muted" data-role="caption"></p>
        </div>
      </div>
      <div class="docker-overview" data-role="overview">
        ${[
          { key: "health", label: "容器健康度", tone: "tone-olive" },
          { key: "cpu", label: "容器 CPU", tone: "tone-accent" },
          { key: "memory", label: "容器内存", tone: "tone-green" },
        ].map(renderSummaryMeterCardMarkup).join("")}
      </div>
      <div class="docker-list" data-role="list"></div>
    </article>

    <article class="detail-card" data-breakdown="network">
      <div class="detail-head">
        <div>
          <h3>网卡</h3>
        </div>
      </div>
      <div class="detail-list" data-role="list"></div>
    </article>

    <article class="detail-card" data-breakdown="disk">
      <div class="detail-head">
        <div>
          <h3>磁盘</h3>
        </div>
      </div>
      <div class="detail-list" data-role="list"></div>
    </article>
  `;
  breakdownScaffoldReady = true;
}

function patchSummaryMeterCard(card) {
  const cardEl = dom.resourceBreakdownsEl.querySelector(`[data-summary-card="${card.key}"]`);
  if (!cardEl) {
    return;
  }
  setText(cardEl.querySelector('[data-role="value"]'), card.value);
  setText(cardEl.querySelector('[data-role="note"]'), card.note);
  setText(cardEl.querySelector('[data-role="ring-label"]'), card.value);
  setStyleVariable(cardEl.querySelector('[data-role="ring"]'), "--percent", clampPercent(card.percent));
}

function patchDockerSection(docker) {
  ensureBreakdownScaffold();
  const section = dom.resourceBreakdownsEl.querySelector('[data-breakdown="docker"]');
  const overviewEl = section?.querySelector('[data-role="overview"]');
  const captionEl = section?.querySelector('[data-role="caption"]');
  const listEl = section?.querySelector('[data-role="list"]');
  const summary = summarizeDocker(docker);

  if (!summary.available) {
    overviewEl?.classList.add("hidden");
    setText(captionEl, "实时读取本机 Docker 状态，用于区分容器不可用和面板采样延迟。");
    setInnerHTML(
      listEl,
      `<div class="detail-empty">${escapeHtml(summary.message || "当前节点无法读取 Docker")}</div>`
    );
    return;
  }

  overviewEl?.classList.remove("hidden");
  setText(captionEl, "");
  [
    {
      key: "health",
      value: `${summary.healthyCount} / ${summary.runningCount || 0}`,
      note: "按当前运行容器的健康状态计算",
      percent: summary.healthPercent,
    },
    {
      key: "cpu",
      value: summary.averageCpu === null ? "-" : formatMetricPercent(summary.averageCpu),
      note: "运行容器当前 CPU 平均值",
      percent: summary.averageCpu,
    },
    {
      key: "memory",
      value: summary.averageMemory === null ? "-" : formatMetricPercent(summary.averageMemory),
      note: "运行容器当前内存平均值",
      percent: summary.averageMemory,
    },
  ].forEach(patchSummaryMeterCard);

  setInnerHTML(
    listEl,
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
  );
}

function patchNetworkSection(snapshot) {
  ensureBreakdownScaffold();
  const listEl = dom.resourceBreakdownsEl.querySelector('[data-breakdown="network"] [data-role="list"]');
  const interfaces = [...(snapshot.network_interfaces || [])].sort(
    (left, right) => right.download_bps + right.upload_bps - (left.download_bps + left.upload_bps)
  );

  setInnerHTML(
    listEl,
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
  );
}

function patchDiskSection(snapshot) {
  ensureBreakdownScaffold();
  const listEl = dom.resourceBreakdownsEl.querySelector('[data-breakdown="disk"] [data-role="list"]');
  const diskDevices = [...(snapshot.disk_devices || [])].sort(
    (left, right) => right.read_bps + right.write_bps - (left.read_bps + left.write_bps)
  );

  setInnerHTML(
    listEl,
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
  );
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

function renderResourceOverview(snapshot, historyPayload) {
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

  patchResources(
    buildRollupCards(snapshot, historyPayload, summary),
    buildRuntimeCards(snapshot, historyPayload, swap, inode, processes)
  );
}

function renderResourceBreakdowns(snapshot, docker) {
  ensureBreakdownScaffold();
  patchDockerSection(docker);
  patchNetworkSection(snapshot);
  patchDiskSection(snapshot);
}

function renderResources(snapshot, historyPayload, docker) {
  renderResourceOverview(snapshot, historyPayload);
  renderResourceBreakdowns(snapshot, docker);
}

function renderLegend() {
  if (dom.chartLegendEl.childElementCount) {
    return;
  }
  dom.chartLegendEl.innerHTML = CHART_SERIES.map(
    (series) => `
      <span class="legend-chip">
        <i style="background:${series.color}"></i>
        ${escapeHtml(series.label)}
      </span>
    `
  ).join("");
}

function chartPointX(index, pointsLength) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  if (pointsLength === 1) {
    return CHART_PADDING.left + plotWidth / 2;
  }
  return CHART_PADDING.left + (index / (pointsLength - 1)) * plotWidth;
}

function chartPointY(value) {
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  return CHART_PADDING.top + ((100 - clampPercent(value)) / 100) * plotHeight;
}

function buildChartGridMarkup() {
  const gridValues = [0, 25, 50, 75, 100];
  return gridValues
    .map(
      (value) => `
        <line x1="${CHART_PADDING.left}" y1="${chartPointY(value)}" x2="${CHART_WIDTH - CHART_PADDING.right}" y2="${chartPointY(value)}" />
        <text x="4" y="${chartPointY(value) + 4}">${value}%</text>
      `
    )
    .join("");
}

function ensureChartScaffold() {
  renderLegend();
  if (chartScaffoldReady && dom.resourceChartEl.querySelector("svg")) {
    return;
  }

  dom.resourceChartEl.className = "chart";
  dom.resourceChartEl.innerHTML = `
    <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none" aria-label="资源趋势图">
      <g class="chart-grid">${buildChartGridMarkup()}</g>
      <g class="chart-lines">
        ${
          CHART_SERIES.map(
            (series) => `
              <polyline
                data-series="${escapeHtml(series.key)}"
                fill="none"
                stroke="${series.color}"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              ></polyline>
              <circle data-point="${escapeHtml(series.key)}" r="4.5" fill="${series.color}"></circle>
            `
          ).join("")
        }
      </g>
      <text class="chart-axis" data-axis="start" x="${CHART_PADDING.left}" y="${CHART_HEIGHT - 8}"></text>
      <text
        class="chart-axis"
        data-axis="end"
        x="${CHART_WIDTH - CHART_PADDING.right}"
        y="${CHART_HEIGHT - 8}"
        text-anchor="end"
      ></text>
    </svg>
  `;
  chartScaffoldReady = true;
}

function renderResourceChart(payload) {
  const points = Array.isArray(payload?.points) ? payload.points : [];
  state.resourceSampleInterval = Number(payload?.interval_seconds) || state.resourceSampleInterval;
  state.resourceRange = payload?.range_key || state.resourceRange;
  syncRangeButtons();

  if (!points.length) {
    chartScaffoldReady = false;
    setChartPlaceholder("当前时间范围内还没有足够的历史样本");
    return;
  }

  const startLabel = formatShortTime(points[0].timestamp);
  const endLabel = formatShortTime(points[points.length - 1].timestamp);
  dom.chartRangeEl.textContent = `${rangeLabel(payload.range_key)} · ${payload.point_count} 点`;
  dom.chartCaptionEl.textContent = `当前查看 ${rangeLabel(payload.range_key)} 的趋势，原始采样 ${payload.interval_seconds} 秒，图表分辨率 ${resolutionLabel(payload.resolution_seconds)}`;
  ensureChartScaffold();
  dom.resourceChartEl.className = "chart";

  CHART_SERIES.forEach((series) => {
    const polyline = dom.resourceChartEl.querySelector(`[data-series="${series.key}"]`);
    const circle = dom.resourceChartEl.querySelector(`[data-point="${series.key}"]`);
    const polylinePoints = points
      .map((point, index) => {
        const value = Number.isFinite(Number(point?.[series.key])) ? Number(point[series.key]) : 0;
        return `${chartPointX(index, points.length)},${chartPointY(value)}`;
      })
      .join(" ");
    const lastPoint = points[points.length - 1];
    const lastValue = Number.isFinite(Number(lastPoint?.[series.key]))
      ? Number(lastPoint[series.key])
      : 0;

    if (polyline?.getAttribute("points") !== polylinePoints) {
      polyline?.setAttribute("points", polylinePoints);
    }
    if (circle?.getAttribute("cx") !== String(chartPointX(points.length - 1, points.length))) {
      circle?.setAttribute("cx", String(chartPointX(points.length - 1, points.length)));
    }
    if (circle?.getAttribute("cy") !== String(chartPointY(lastValue))) {
      circle?.setAttribute("cy", String(chartPointY(lastValue)));
    }
  });

  setText(dom.resourceChartEl.querySelector('[data-axis="start"]'), startLabel);
  setText(dom.resourceChartEl.querySelector('[data-axis="end"]'), endLabel);
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
  const previousRange = state.resourceRange;
  state.resourceRange = rangeKey;
  syncRangeButtons();
  try {
    await loadResourceHistoryOnly();
  } catch (error) {
    state.resourceRange = previousRange;
    syncRangeButtons();
    showStatus(error.message, "error");
  }
}

dom.resourceRangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    void switchRange(button.dataset.range);
  });
});

async function loadResourceHistoryOnly() {
  if (!latestResourceSnapshot || !state.resourcesLoaded) {
    await loadResourcesSection();
    return;
  }

  const requestEpoch = ++resourceRequestEpoch;
  const historyPayload = await request(
    `/api/resources/history?range=${encodeURIComponent(state.resourceRange)}`
  );
  if (requestEpoch !== resourceRequestEpoch) {
    return;
  }

  renderResourceOverview(latestResourceSnapshot, historyPayload);
  renderResourceChart(historyPayload);
}

export async function loadResourcesSection({ forceRefresh = false } = {}) {
  const requestEpoch = ++resourceRequestEpoch;
  const historyPath = `/api/resources/history?range=${encodeURIComponent(state.resourceRange)}`;
  const [snapshotResult, historyResult, dockerResult] = await Promise.allSettled([
    request(`/api/resources${forceRefresh ? "?fresh=true" : ""}`),
    request(historyPath),
    request("/api/runtime/docker"),
  ]);

  if (snapshotResult.status !== "fulfilled") {
    if (requestEpoch !== resourceRequestEpoch) {
      return;
    }
    state.resourcesLoaded = false;
    setResourcesPlaceholder(snapshotResult.reason.message);
    throw snapshotResult.reason;
  }

  if (requestEpoch !== resourceRequestEpoch) {
    return;
  }

  const historyPayload =
    historyResult.status === "fulfilled"
      ? historyResult.value
      : buildFallbackHistory(snapshotResult.value);

  latestResourceSnapshot = snapshotResult.value;
  latestDockerStatus = dockerResult.status === "fulfilled" ? dockerResult.value : null;
  state.resourcesLoaded = true;
  renderResources(
    latestResourceSnapshot,
    historyPayload,
    latestDockerStatus
  );

  if (historyResult.status === "fulfilled") {
    renderResourceChart(historyResult.value);
  } else {
    renderResourceChart(historyPayload);
  }

  if (dockerResult.status === "rejected") {
    state.docker = null;
  } else {
    state.docker = latestDockerStatus;
  }
}
