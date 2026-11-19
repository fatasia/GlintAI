export type LocalAgentRequest = { action: string; [key: string]: unknown };

export type LocalAgentSettingsRequest =
  | { action: "list" }
  | { action: "status"; agentId: string }
  | { action: "locate"; agentId: string; path: string }
  | { action: "configure"; agentId: string; enabled: boolean };

export interface LocalAgent {
  id: string;
  name: string;
  installed: boolean;
  status: string;
  version?: string;
  path?: string;
  message?: string;
  enabled?: boolean;
}

export interface LocalAgentList {
  agents: LocalAgent[];
  conversations?: unknown[];
}

type DesktopBridge = { request(request: LocalAgentRequest): Promise<unknown> };
const REQUEST_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 70_000;
const desktopBridge = () => typeof window === "undefined" ? undefined
  : (window as Window & { glintDesktop?: DesktopBridge }).glintDesktop;

export function isLocalAgentAvailable(): boolean {
  return typeof desktopBridge()?.request === "function";
}

/** The desktop owns processes and credentials; the web client keeps neither. */
export async function localAgentRequest<T>(request: LocalAgentRequest): Promise<T> {
  const bridge = desktopBridge();
  if (typeof bridge?.request !== "function") throw new Error("请在桌面版使用本地智能体；API 模型和媒体服务仍可正常使用。");
  const timeoutMs = request.action === "connect" || request.action === "archive" ? CONNECT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.request(request),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("本地智能体响应超时，请检查本机进程后重试。")), timeoutMs); }),
    ]);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("桌面版返回了无效响应，请刷新后重试。");
    const payload = result as { error?: unknown; ok?: boolean };
    if (payload.error || payload.ok === false) {
      const error = payload.error;
      const detail = typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : "桌面版未完成操作";
      throw new Error(detail);
    }
    return result as T;
  } finally { clearTimeout(timer); }
}

function isAgent(value: unknown): value is LocalAgent {
  if (!value || typeof value !== "object") return false;
  const agent = value as LocalAgent;
  return typeof agent.id === "string" && Boolean(agent.id.trim()) && typeof agent.name === "string"
    && typeof agent.installed === "boolean" && typeof agent.status === "string"
    && [agent.path, agent.version, agent.message].every(item => item === undefined || typeof item === "string")
    && (agent.enabled === undefined || typeof agent.enabled === "boolean");
}

export function readLocalAgentList(value: unknown): LocalAgent[] {
  const agents = (value as LocalAgentList | null)?.agents;
  if (!Array.isArray(agents) || !agents.every(isAgent) || new Set(agents.map(agent => agent.id)).size !== agents.length) {
    throw new Error("智能体列表无效，请刷新检测。");
  }
  return agents;
}

/** Mutations may return an agent, a list, or an acknowledgement followed by status. */
export function readLocalAgentUpdate(value: unknown, agentId: string): LocalAgent | undefined {
  if (isAgent(value)) return value.id === agentId ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  if ("agent" in value && isAgent(value.agent)) return value.agent.id === agentId ? value.agent : undefined;
  if ("agents" in value) return readLocalAgentList(value).find(agent => agent.id === agentId);
  return undefined;
}
