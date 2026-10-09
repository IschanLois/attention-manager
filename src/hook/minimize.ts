// Keep only what the receiver uses for task context: the command, path and description of
// a tool call, a prompt snippet and an assistant message snippet. Tool outputs, file
// contents and transcript paths never cross the socket.
const PROMPT_LIMIT = 400;
const COMMAND_LIMIT = 400;
const DESCRIPTION_LIMIT = 200;
const MESSAGE_LIMIT = 600;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(source: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function minimizePayload(payload: unknown): unknown {
  if (!isObject(payload)) return payload;
  const { tool_response: _response, transcript_path: _transcript, tool_input: toolInput, ...rest } = payload;
  const result: Json = { ...rest };
  if (isObject(toolInput)) {
    const command = firstString(toolInput, ["command"]);
    const filePath = firstString(toolInput, ["file_path", "path", "notebook_path"]);
    const description = firstString(toolInput, ["description"]);
    result.tool_input = {
      ...(command !== undefined ? { command: command.slice(0, COMMAND_LIMIT) } : {}),
      ...(filePath !== undefined ? { file_path: filePath } : {}),
      ...(description !== undefined ? { description: description.slice(0, DESCRIPTION_LIMIT) } : {}),
    };
  }
  if (typeof result.prompt === "string") result.prompt = result.prompt.slice(0, PROMPT_LIMIT);
  if (typeof result.last_assistant_message === "string") result.last_assistant_message = result.last_assistant_message.slice(0, MESSAGE_LIMIT);
  return result;
}
