export type PermissionMode = "default" | "auto" | "plan";
export type ApiFormat = "anthropic" | "openai";

export interface Config {
  apiUrl: string;
  apiKey: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingBudget: number; // 0 = disabled
  apiFormat: ApiFormat;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  thinking?: string;
  signature?: string;
  source?: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
  cache_control?: CacheControl;
}

export interface CacheControl {
  type: "ephemeral";
  scope?: "global" | "org";
}

export interface SystemPromptBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface SystemPromptSection {
  name: string;
  cacheBreak: boolean;
  scope?: "global" | "org";
  compute: () => Promise<string | null>;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolPermissionControl {
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
}

export interface ToolContext {
  config: Config;
  permissionControl?: ToolPermissionControl;
  askUser?: (question: string) => Promise<string>;
}
