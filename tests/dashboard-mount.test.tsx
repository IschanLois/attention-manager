// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type { HealthReport, SessionsSnapshot } from "@/lib/types";

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {}
}

const NOW = "2026-10-09T10:00:00.000Z";

const snapshot: SessionsSnapshot = {
  now: NOW,
  staleAfterMs: 600_000,
  sessions: [
    {
      sessionId: "11111111-2222-3333-4444-555555555555",
      label: "demo-app",
      startedAt: NOW,
      lastSeenAt: NOW,
      lastEventType: "permission_request",
      status: "needs_attention",
      priority: "high",
      attentionReason: "Waiting for permission to run Bash",
      classificationConfidence: null,
      classificationSource: "rule",
      classifiedAt: null,
      classificationEvidence: [],
      classificationError: null,
      endedAt: null,
      recentFailureTimes: [],
      pendingPermissionToolUseId: "toolu_1",
      eventSeq: 3,
      taskSummary: "Drop the legacy_users table and run the migration",
      recentActions: ["Bash: psql -c 'DROP TABLE legacy_users'", "Write: src/db/migrate.ts"],
      lastNarration: "I will drop the table now.",
      taskRuleSeverity: "critical",
      taskSeverity: "critical",
      taskSeveritySource: "rule",
      taskSeverityReason: "Destructive DDL against a database table",
      taskSeverityEvidence: ["DROP TABLE"],
      taskSeverityConfidence: null,
      taskClassifiedAt: NOW,
      terminal: null,
      stale: false,
    },
  ],
};

const health: HealthReport = {
  ok: true,
  version: "0.1.0",
  uptimeSeconds: 1,
  receiver: { host: "127.0.0.1", port: 4318, sseClients: 1 },
  sqlite: { ok: true, path: "x", error: null },
  model: { reachable: true, modelInstalled: true, model: "m", url: "u", error: null },
  lastEventAt: NOW,
  lastClassificationError: null,
  sessionCount: 1,
};

describe("Dashboard mount", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders the initial snapshot without an update loop", async () => {
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args));
    await act(async () => {
      root.render(
        <Dashboard initialSnapshot={snapshot} initialHealth={health} initialFilters={DEFAULT_FILTERS} receiverUrl="http://127.0.0.1:4318" serverNow={NOW} />,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    consoleError.mockRestore();
    expect(JSON.stringify(errors)).not.toMatch(/Maximum update depth|getSnapshot should be cached/);
    expect(container.textContent).toContain("demo-app");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Waiting for permission to run Bash");
    expect(container.textContent).toContain("Risk: CRITICAL");
    expect(container.textContent).toContain("Task: Drop the legacy_users table and run the migration");
    expect(container.textContent).toContain("1 high-risk");
    expect(container.querySelector('[role="group"][aria-label="Filter by risk"]')).not.toBeNull();
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/stream");
  });
});
