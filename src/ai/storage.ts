import { emptyConfig, type AIConfig, type AIConnection } from "./types";
export const configKey = (owner: string) => "sediment-ai:v1:" + owner;
function validConnection(value: unknown): value is AIConnection {
  if (!value || typeof value !== "object") return false;
  const c = value as AIConnection;
  return typeof c.id === "string" && typeof c.name === "string" && typeof c.baseUrl === "string" && typeof c.key === "string" && (c.protocol === "openai" || c.protocol === "anthropic") && Array.isArray(c.models) && c.models.every(m => typeof m.id === "string" && typeof m.name === "string" && typeof m.enabled === "boolean");
}
export function loadConfig(owner: string, local: Storage = localStorage, session: Storage = sessionStorage): AIConfig {
  try {
    const stored = JSON.parse(local.getItem(configKey(owner)) || "null");
    const temporary = JSON.parse(session.getItem(configKey(owner)) || "[]");
    if (!stored || stored.version !== 1) return emptyConfig();
    const connections = Array.isArray(stored.connections) ? stored.connections.filter(validConnection) : [];
    const temporaryKeys = new Map<string,string>(Array.isArray(temporary) ? temporary.filter((x: {id?:unknown;key?:unknown}) => typeof x.id === "string" && typeof x.key === "string").map((x:{id:string;key:string}) => [x.id,x.key]) : []);
    return {version:1, connections:connections.map((c:AIConnection) => ({...c,key:c.remember ? c.key : temporaryKeys.get(c.id) || ""})), defaultModel:typeof stored.defaultModel === "string" ? stored.defaultModel : "", maxTokens:Math.min(8192,Math.max(256,Number(stored.maxTokens)||2048))};
  } catch { return emptyConfig(); }
}
export function persistConfig(owner: string, config: AIConfig, local: Storage = localStorage, session: Storage = sessionStorage) {
  // Do not pass this object to workspace preferences, exports, or HTTP APIs.
  const sessionKeys = config.connections.filter(c => !c.remember).map(c => ({id:c.id,key:c.key}));
  session.setItem(configKey(owner), JSON.stringify(sessionKeys));
  local.setItem(configKey(owner), JSON.stringify({...config,connections:config.connections.map(c => ({...c,key:c.remember ? c.key : ""}))}));
}
export function clearConfig(owner: string) { localStorage.removeItem(configKey(owner)); sessionStorage.removeItem(configKey(owner)); }
export function scrubSecrets(text: string, config: AIConfig): string { return config.connections.reduce((value,c) => c.key ? value.split(c.key).join("[已隐藏凭据]") : value, text); }
