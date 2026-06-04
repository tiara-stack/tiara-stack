export const DISCORD_THREAD_NAME_MAX_LENGTH = 100;
export const DISCORD_MESSAGE_MAX_LENGTH = 2000;

// Output Processing Constants
export const DIFF_TRUNCATION_LINES = 10;
export const SAFE_SPLIT_THRESHOLD = 0.7; // Don't go below 70% of max length when searching for split point
export const DISCORD_STREAM_EDIT_INTERVAL_MS = 500;
export const DISCORD_STREAM_SEGMENT_MAX_LENGTH = 1900;
export const STREAM_CHUNKING_MODE = "word";

// Diff Formatting Constants
export const DIFF_CONTEXT_LINES = 1;

// Status Emojis
export const STATUS_EMOJI = {
  COMPLETED: "✓",
  IN_PROGRESS: "◐",
  PENDING: "○",
} as const;

// Update Types
export const UPDATE_TYPE = {
  AGENT_MESSAGE: "agent_message",
  AGENT_THOUGHT: "agent_thought",
  TOOL_CALL: "tool_call",
  DIFF: "diff",
  TODO: "todo",
  USER_MESSAGE: "user_message",
} as const;

// Session Status
export const SESSION_STATUS = {
  RUNNING: "running",
  COMPLETED: "completed",
  IN_PROGRESS: "in_progress",
} as const;
