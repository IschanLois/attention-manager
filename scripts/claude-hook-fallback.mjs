// Fallback forwarder used by claude-hook.sh when curl is not installed.
// Reads the hook payload from stdin and POSTs it with a hard timeout.
const url = `${process.env.ATTENTION_RECEIVER_URL ?? "http://127.0.0.1:4318"}/api/events`;
const token = process.env.ATTENTION_TOKEN ?? "";
const timeoutMs = Number(process.env.ATTENTION_HOOK_TIMEOUT ?? "2") * 1000;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks);

try {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-attention-token": token },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
} catch {
  // The receiver being down must never block Claude Code.
}
process.exit(0);
