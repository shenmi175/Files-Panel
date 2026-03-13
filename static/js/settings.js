import {
  dom,
  metricCard,
  normalizeFeatureError,
  request,
  setAccessPlaceholder,
  setConfigPlaceholder,
  showStatus,
  state,
  updateHeroAccess,
} from "./shared.js";

export function renderAccess(payload) {
  state.access = payload;
  updateHeroAccess();

  if (payload.public_url) {
    dom.accessSummaryEl.textContent = payload.restart_pending
      ? `域名已接入：${payload.public_url}，等待 agent 切回本地监听`
      : `域名已接入：${payload.public_url}`;
  } else if (payload.public_ip_access_enabled) {
    dom.accessSummaryEl.textContent = `当前临时开放 IP:${payload.desired_bind_port} 访问`;
  } else {
    dom.accessSummaryEl.textContent = "当前只接受本地访问";
  }

  const publicEntry = payload.public_url
    ? payload.public_url
    : payload.public_ip_access_enabled
      ? `http://服务器IP:${payload.desired_bind_port}`
      : "仅本地监听";
  const nginxStatus = payload.nginx_available
    ? payload.nginx_running
      ? "已运行"
      : "已安装，等待 reload"
    : "未安装";

  dom.accessCardsEl.className = "metric-grid";
  dom.accessCardsEl.innerHTML = [
    metricCard({
      label: "当前监听",
      value: `${payload.current_bind_host}:${payload.current_bind_port}`,
      note: payload.restart_pending ? "重启后会切换到新的监听地址" : "当前生效",
      tone: "tone-accent",
    }),
    metricCard({
      label: "目标监听",
      value: `${payload.desired_bind_host}:${payload.desired_bind_port}`,
      note: payload.public_ip_access_enabled ? "仍允许通过 IP 访问" : "域名完成后只保留本地监听",
      tone: "tone-green",
    }),
    metricCard({
      label: "对外入口",
      value: publicEntry,
      note: payload.token_configured ? "Bearer Token 已配置" : "未配置访问令牌",
      tone: "tone-amber",
    }),
    metricCard({
      label: "Nginx / Certbot",
      value: nginxStatus,
      note: payload.https_enabled
        ? "HTTPS 已就绪"
        : payload.certbot_available
          ? "证书将在域名接入时申请"
          : "未检测到 certbot",
      tone: "tone-olive",
    }),
  ].join("");
}

export function renderConfig(config) {
  state.config = config;
  dom.configAgentNameInput.value = config.agent_name;
  dom.configAgentRootInput.value = config.agent_root;
  dom.configPortInput.value = String(config.port);
  dom.configCertbotEmailInput.value = config.certbot_email || "";
  dom.configAllowPublicInput.checked = config.allow_public_ip;
  dom.configAllowRestartInput.checked = config.allow_self_restart;

  dom.configSummaryEl.className = "metric-grid";
  dom.configSummaryEl.innerHTML = [
    metricCard({
      label: "固定根目录",
      value: config.agent_root,
      note: "文件操作不会越过这个边界",
      tone: "tone-accent",
    }),
    metricCard({
      label: "目标监听",
      value: `${config.desired_bind_host}:${config.desired_bind_port}`,
      note: `当前运行 ${config.current_bind_host}:${config.current_bind_port}`,
      tone: "tone-green",
    }),
    metricCard({
      label: "域名状态",
      value: config.public_domain || "未接入域名",
      note: config.restart_pending ? "存在待重启生效的参数" : "当前环境文件已同步",
      tone: "tone-amber",
    }),
    metricCard({
      label: "鉴权 / 证书",
      value: config.token_configured ? "Bearer Token 已配置" : "未配置 Token",
      note: config.certbot_email || "未设置 Certbot 邮箱",
      tone: "tone-olive",
    }),
  ].join("");
}

export async function loadAccess() {
  renderAccess(await request("/api/access"));
}

export async function loadConfig() {
  renderConfig(await request("/api/config"));
}

export async function refreshSettings({ includeConfig = true } = {}) {
  const [accessResult, configResult] = await Promise.allSettled([
    loadAccess(),
    includeConfig ? loadConfig() : Promise.resolve(),
  ]);
  if (accessResult.status === "rejected") {
    setAccessPlaceholder(accessResult.reason.message);
    throw accessResult.reason;
  }
  if (includeConfig && configResult.status === "rejected") {
    setConfigPlaceholder(normalizeFeatureError(configResult.reason, "固定参数"));
  }
}

export async function configureDomain(event) {
  event.preventDefault();
  const domain = dom.domainInput.value.trim();
  if (!domain) {
    showStatus("请输入域名", "error");
    return;
  }

  try {
    const payload = await request("/api/access/domain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    dom.domainInput.value = "";
    showStatus(
      payload.restart_scheduled
        ? `域名已接入：${payload.public_url}。agent 将自动切回仅本地监听。`
        : `域名已接入：${payload.public_url}`,
      "success"
    );
    await refreshSettings().catch(() => {});
  } catch (error) {
    showStatus(error.message, "error");
  }
}

export async function saveConfig(event) {
  event.preventDefault();
  const nextPort = Number(dom.configPortInput.value);
  if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
    showStatus("监听端口必须是 1-65535 之间的整数", "error");
    return;
  }

  try {
    const payload = await request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: dom.configAgentNameInput.value.trim(),
        agent_root: dom.configAgentRootInput.value.trim(),
        port: nextPort,
        allow_public_ip: dom.configAllowPublicInput.checked,
        certbot_email: dom.configCertbotEmailInput.value.trim(),
        allow_self_restart: dom.configAllowRestartInput.checked,
      }),
    });
    renderConfig(payload.config);
    await loadAccess().catch(() => {});
    showStatus(
      payload.restart_scheduled
        ? "固定参数已保存，agent 正在重启应用新参数"
        : payload.restart_required
          ? "固定参数已保存，等待你手动重启 agent 生效"
          : "固定参数已保存",
      payload.restart_required ? "info" : "success"
    );
  } catch (error) {
    showStatus(error.message, "error");
  }
}
