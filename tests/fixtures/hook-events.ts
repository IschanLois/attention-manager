// Payloads captured from Claude Code 2.1.295 hooks on 2026-10-09 (paths shortened).
export const SESSION_A = "eccfdb51-15cf-4303-aef4-dd2471f958d4";
export const SESSION_B = "de0f5258-de14-4506-912f-deba68a6e3b9";

const common = (sessionId: string) => ({
  session_id: sessionId,
  transcript_path: `/home/dev/.claude/projects/-home-dev-proj/${sessionId}.jsonl`,
  cwd: "/home/dev/Projects/my-app",
});

export const sessionStart = (sessionId = SESSION_A) => ({
  ...common(sessionId),
  hook_event_name: "SessionStart",
  source: "startup",
});

export const userPromptSubmit = (sessionId = SESSION_A) => ({
  ...common(sessionId),
  prompt_id: "a1b98b82-3f04-4839-b00c-a49e1c8a8ccd",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt: "Run the shell command 'node hello.js' using the Bash tool, then reply DONE.",
});

export const preToolUse = (sessionId = SESSION_A, toolUseId = "toolu_01U2K8opAqAnrxxo63GfahFu") => ({
  ...common(sessionId),
  prompt_id: "a1b98b82-3f04-4839-b00c-a49e1c8a8ccd",
  permission_mode: "default",
  effort: { level: "high" },
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "node hello.js", description: "Run hello.js with Node" },
  tool_use_id: toolUseId,
});

export const postToolUse = (sessionId = SESSION_A, toolUseId = "toolu_01U2K8opAqAnrxxo63GfahFu") => ({
  ...common(sessionId),
  prompt_id: "a1b98b82-3f04-4839-b00c-a49e1c8a8ccd",
  permission_mode: "default",
  effort: { level: "high" },
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "node hello.js", description: "Run hello.js with Node" },
  tool_response: { stdout: "probe", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
  tool_use_id: toolUseId,
  duration_ms: 68,
});

export const postToolUseFailure = (sessionId = SESSION_A, toolUseId = "toolu_012WhF3yhSxZxXNjk5eKRGDJ") => ({
  ...common(sessionId),
  prompt_id: "a1b98b82-3f04-4839-b00c-a49e1c8a8ccd",
  permission_mode: "default",
  effort: { level: "high" },
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "cat does-not-exist.txt", description: "Print contents of a missing file" },
  tool_use_id: toolUseId,
  error: "Exit code 1\ncat: does-not-exist.txt: No such file or directory",
  is_interrupt: false,
  duration_ms: 10,
});

export const permissionRequest = (sessionId = SESSION_B, toolUseId = "toolu_01HNJhjMNUijyBRhiiwRiBJC") => ({
  ...common(sessionId),
  prompt_id: "6ee8b20b-3996-4aba-9cb9-c08f6cdb28e4",
  permission_mode: "default",
  effort: { level: "high" },
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "touch probe-file.txt", description: "Create empty probe file" },
  tool_use_id: toolUseId,
  permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
});

export const permissionNotification = (sessionId = SESSION_B) => ({
  ...common(sessionId),
  prompt_id: "b5a2e11e-5778-4aa6-9e47-d0299b69aff9",
  hook_event_name: "Notification",
  message: "Claude needs your permission",
  notification_type: "permission_prompt",
});

export const idleNotification = (sessionId = SESSION_B) => ({
  ...common(sessionId),
  hook_event_name: "Notification",
  message: "Claude is waiting for your input",
  notification_type: "idle_prompt",
});

export const unknownNotification = (sessionId = SESSION_B, message = "Rate limit reached, retrying in 30s") => ({
  ...common(sessionId),
  hook_event_name: "Notification",
  message,
  notification_type: "custom_type",
});

export const stop = (sessionId = SESSION_A, lastAssistantMessage = "DONE") => ({
  ...common(sessionId),
  prompt_id: "a1b98b82-3f04-4839-b00c-a49e1c8a8ccd",
  permission_mode: "default",
  effort: { level: "high" },
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: lastAssistantMessage,
  background_tasks: [],
  session_crons: [],
});

export const subagentStop = (sessionId = SESSION_A) => ({
  ...common(sessionId),
  hook_event_name: "SubagentStop",
  stop_hook_active: false,
});

export const sessionEnd = (sessionId = SESSION_A, reason = "prompt_input_exit") => ({
  ...common(sessionId),
  prompt_id: "a1b98b82-3f04-4839-b00c-a49e1c8a8ccd",
  hook_event_name: "SessionEnd",
  reason,
});

export const instructionsLoaded = (sessionId = SESSION_A) => ({
  ...common(sessionId),
  hook_event_name: "InstructionsLoaded",
  file_path: "/home/dev/.claude/CLAUDE.md",
  memory_type: "User",
  load_reason: "session_start",
});
