import type { ExternalTool, SessionOptions } from "@moonshot-ai/kimi-agent-sdk";
import * as Context from "effect/Context";

export type ApprovalPolicy = "reject" | "allow-read-only-git";

export type ConfigShape = {
  readonly workDir?: string;
  readonly executable?: string;
  readonly env?: Record<string, string>;
  readonly thinking?: boolean;
  readonly yoloMode?: boolean;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly agentFile?: string;
  readonly skillsDir?: string;
  readonly shareDir?: string;
  readonly timeoutMs?: number;
  readonly cleanupGraceMs?: number;
  readonly externalTools?: ReadonlyArray<ExternalTool>;
  readonly session?: Partial<Omit<SessionOptions, "externalTools" | "workDir">>;
};

export class Config extends Context.Service<Config, ConfigShape>()("effect-ai-kimi/KimiConfig") {}
