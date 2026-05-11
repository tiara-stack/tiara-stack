import type { ThreadOptions } from "@openai/codex-sdk";
import * as Context from "effect/Context";

export type CodexConfigValue =
  | string
  | number
  | boolean
  | Array<CodexConfigValue>
  | CodexConfigObject;

export type CodexConfigObject = {
  [key: string]: CodexConfigValue;
};

export type ConfigShape = {
  readonly codexPathOverride?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly env?: Record<string, string>;
  readonly config?: CodexConfigObject;
  readonly thread?: Partial<ThreadOptions>;
  readonly timeoutMs?: number;
  readonly cleanupGraceMs?: number;
  readonly structuredResponseMaxCharacters?: number;
  readonly strictStructuredResponseItemTypes?: boolean;
};

export class Config extends Context.Service<Config, ConfigShape>()("effect-ai-codex/CodexConfig") {}

export type CodexMcpServerConfig = {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly enabled_tools?: ReadonlyArray<string>;
  readonly startup_timeout_ms?: number;
  readonly tool_timeout_sec?: number;
  readonly required?: boolean;
};

const mcpServerConfigToObject = (server: CodexMcpServerConfig): CodexConfigObject => {
  const config: CodexConfigObject = {
    command: server.command,
  };
  if (server.args !== undefined) {
    config.args = [...server.args];
  }
  if (server.cwd !== undefined) {
    config.cwd = server.cwd;
  }
  if (server.enabled_tools !== undefined) {
    config.enabled_tools = [...server.enabled_tools];
  }
  if (server.startup_timeout_ms !== undefined) {
    config.startup_timeout_ms = server.startup_timeout_ms;
  }
  if (server.tool_timeout_sec !== undefined) {
    config.tool_timeout_sec = server.tool_timeout_sec;
  }
  if (server.required !== undefined) {
    config.required = server.required;
  }
  return config;
};

export const makeMcpServerConfig = (
  servers: Record<string, CodexMcpServerConfig>,
): CodexConfigObject => {
  const mcpServers: CodexConfigObject = {};
  for (const [name, server] of Object.entries(servers)) {
    mcpServers[name] = mcpServerConfigToObject(server);
  }
  return { mcp_servers: mcpServers };
};
