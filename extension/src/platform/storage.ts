import type {
  AISettings,
  AuthSession,
  Draft,
  ProviderDefinition,
  QueueEntry,
} from "../types";
import { emptyAISettings } from "../types";

export const storage = {
  async get<T>(key: string, fallback: T): Promise<T> {
    return (
      ((await chrome.storage.local.get(key))[key] as T | undefined) ?? fallback
    );
  },
  async set(key: string, value: unknown) {
    await chrome.storage.local.set({ [key]: value });
  },
};
export async function restrictStorage() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
}
export async function getAuth(): Promise<AuthSession | null> {
  return storage.get("auth:v1", null);
}
export async function putAuth(auth: AuthSession | null) {
  await storage.set("auth:v1", auth);
}
export const getQueue = () => storage.get<QueueEntry[]>("queue:v1", []);
export const putQueue = (entries: QueueEntry[]) =>
  storage.set("queue:v1", entries);
export const getDrafts = () => storage.get<Draft[]>("drafts:v1", []);
export const putDrafts = (entries: Draft[]) =>
  storage.set("drafts:v1", entries);
export const getAISettings = (owner: string) =>
  storage.get<AISettings>("ai:config:" + owner, emptyAISettings());
export async function saveAISettings(owner: string, settings: AISettings) {
  // Explicit projection: even a caller passing extra `key` fields cannot persist them here.
  const providers: ProviderDefinition[] = settings.providers.map((p) => ({
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    remember: p.remember,
    apiType: p.apiType,
    models: p.models,
    localUnauthenticated: !!p.localUnauthenticated,
  }));
  await storage.set("ai:config:" + owner, { ...settings, providers });
}
export async function providerKey(owner: string, id: string): Promise<string> {
  const name = "ai:key:" + owner + ":" + id;
  const value =
    (await chrome.storage.session.get(name))[name] ??
    (await chrome.storage.local.get(name))[name];
  return typeof value === "string" ? value : "";
}
export async function saveProviderKey(
  owner: string,
  id: string,
  key: string,
  remember: boolean,
) {
  const name = "ai:key:" + owner + ":" + id;
  await Promise.all([
    chrome.storage.local.remove(name),
    chrome.storage.session.remove(name),
  ]);
  await (remember ? chrome.storage.local : chrome.storage.session).set({
    [name]: key,
  });
}
export async function forgetProvider(owner: string, id: string) {
  const name = "ai:key:" + owner + ":" + id;
  await Promise.all([
    chrome.storage.local.remove(name),
    chrome.storage.session.remove(name),
  ]);
}
export async function knownSecrets(owner: string) {
  const config = await getAISettings(owner),
    auth = await getAuth();
  return [
    ...(await Promise.all(
      config.providers.map((p) => providerKey(owner, p.id)),
    )),
    auth?.accessToken || "",
    auth?.refreshToken || "",
  ].filter(Boolean);
}
