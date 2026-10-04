import type { AIConnection, AIResult } from "../../src/ai/types";

export type CaptureKind =
  | "thought"
  | "article"
  | "selection"
  | "bookmark"
  | "thread";
export type AITask = "summary" | "insight" | "questions" | "polish";
export interface CaptureSource {
  url: string;
  title: string;
  author?: string;
  site?: string;
  coverage:
    | "extracted-article"
    | "selection-only"
    | "loaded-content"
    | "link-only";
  warnings: string[];
}
export interface CaptureEnvelope {
  schema: "sediment.capture.v1";
  id: string;
  kind: CaptureKind;
  title: string;
  text: string;
  thought: string;
  capturedAt: string;
  source?: CaptureSource;
  analysis?: AIResult & { task: AITask; generatedAt: string };
}
export interface Capabilities {
  schema_version: "sediment.api.v1";
  subject: string;
  grant_id: string;
  scopes: string[];
  spaces: string[];
  resource: string;
  expires_at?: number;
}
export interface AuthSession {
  origin: string;
  subject: string;
  grantId: string;
  scopes: string[];
  spaces: string[];
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  resource?: string;
  expiresAt?: number;
}
export type PublicSession = Omit<
  AuthSession,
  "accessToken" | "refreshToken" | "clientId"
>;
export interface WritePayload {
  action: "create_note";
  space_id: string;
  title: string;
  content: string;
  source_refs: [];
  model_attribution: {
    requested_model?: string;
    response_model?: string;
    generated_at?: string;
  };
}
export interface WriteResult {
  item_id?: string;
  revision?: number;
  proposal_id?: string;
  id?: string;
}
export type QueueStatus =
  | "pending"
  | "sending"
  | "failed"
  | "saved"
  | "proposal";
export interface QueueEntry {
  id: string;
  ownerKey: string;
  grantId: string;
  origin: string;
  capture: CaptureEnvelope;
  payload: WritePayload;
  mode: "write" | "proposal";
  status: QueueStatus;
  attempts: number;
  nextAt: number;
  updatedAt: string;
  error?: string;
  result?: WriteResult;
}
export interface Draft {
  id: string;
  ownerKey: string;
  capture: CaptureEnvelope;
  updatedAt: string;
}
export type ProviderDefinition = Omit<AIConnection, "key"> & {
  localUnauthenticated?: boolean;
};
export interface AISettings {
  version: 1;
  providers: ProviderDefinition[];
  defaultModels: Partial<Record<AITask, string>>;
  maxTokens: number;
}
export const emptyAISettings = (): AISettings => ({
  version: 1,
  providers: [],
  defaultModels: {},
  maxTokens: 2048,
});
export const ownerKey = (
  auth: Pick<AuthSession, "origin" | "subject"> | null,
) => (auth ? auth.origin + "|" + auth.subject : "device");
export const DEFAULT_ORIGIN = "https://zhishi.51wanai.com";
// This is an OAuth audience, NOT a URL the extension connects to.
export const DEFAULT_RESOURCE = "http://127.0.0.1:8791/mcp";
