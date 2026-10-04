export type Protocol = "openai" | "anthropic";
export type AIMode = "chat" | "summary" | "analysis";
export interface ModelEntry { id: string; name: string; enabled: boolean; testedAt?: string; testError?: string; missing?: boolean; manual?: boolean; capabilities?: string; }
export interface AIConnection { id: string; name: string; protocol: Protocol; baseUrl: string; key: string; remember: boolean; apiType: "responses" | "chat"; models: ModelEntry[]; allowUnauthenticated?: boolean; }
export interface AIConfig { version: 1; connections: AIConnection[]; defaultModel: string; maxTokens: number; }
export interface AISource { id: string; title: string; text: string; kind: string; locator: string; itemId?: string; url?: string; }
export interface AIResult { text: string; requestedModel: string; model: string; complete: boolean; truncated: boolean; }
export interface AITarget { title: string; itemId?: string; kind?: string; }
export const emptyConfig = (): AIConfig => ({ version: 1, connections: [], defaultModel: "", maxTokens: 2048 });
export const modelKey = (connection: string, model: string) => connection + "::" + model;
export function enabledModels(config: AIConfig) { return config.connections.flatMap(connection => connection.models.filter(m => m.enabled).map(model => ({connection, model, id:modelKey(connection.id, model.id)}))); }
