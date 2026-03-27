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
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
}
