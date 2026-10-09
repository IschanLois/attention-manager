# PRD: Claude Code Attention Manager

**Status:** Draft
**Project type:** Hackathon MVP
**Platform:** Linux
**Primary users:** Developers running multiple Claude Code sessions concurrently
**Implementation stack:** Next.js, Node.js, TypeScript, SQLite, and a locally hosted LLM

## 1. Overview

### Problem statement

When working with multiple Claude Code sessions across terminal tabs and windows, it is difficult to know which sessions require attention without manually checking each terminal.

A session might be waiting for user input, asking for permission, reporting an error, or completing a task while the developer is focused on another session. This creates unnecessary context switching and increases the chance of overlooking a blocked session.

### Proposed solution

Build a local web-based dashboard that monitors multiple Claude Code sessions and identifies which ones need the developer's attention.

The application will:

* Capture relevant lifecycle and notification events through Claude Code hooks.
* Associate events with individual Claude Code sessions.
* Maintain the latest known state of each session.
* Use a locally hosted AI model to classify whether a session needs attention and why.
* Display sessions in a prioritized dashboard.
* Let the developer inspect session details and quickly identify the appropriate terminal to return to.

### Product principles

1. **Local-first:** Session monitoring and AI classification run on the developer's machine.
2. **Low overhead:** Monitoring should not noticeably slow down Claude Code.
3. **Actionable prioritization:** Highlight sessions that need intervention rather than simply listing activity.
4. **Graceful degradation:** The dashboard remains useful when the local AI model is unavailable.
5. **Minimal setup:** Installation should not require writing a native desktop application.

## 2. Goals and non-goals

### Goals

* Detect relevant activity across multiple Claude Code sessions.
* Identify sessions waiting for user input, permission decisions, or error resolution.
* Distinguish actionable interruptions from routine progress notifications.
* Rank sessions by attention priority.
* Provide a live dashboard accessible through a local browser.
* Keep session metadata and classification processing local.
* Make the MVP implementable by a coding agent within a hackathon timeframe.

### Non-goals

The MVP will not:

* Automatically approve tool permissions or execute commands on behalf of the user.
* Automatically switch terminal tabs or manipulate terminal windows.
* Control Claude Code conversations directly.
* Replace Claude Code's built-in notifications or permission controls.
* Support remote monitoring across multiple machines.
* Require a cloud-hosted LLM or external AI API.
* Build a native desktop application.
* Provide comprehensive analytics, productivity scoring, or historical reporting.

## 3. Target user and primary workflow

The target user is a developer running two or more Claude Code sessions in separate terminal tabs or windows on Linux.

### Primary workflow

1. The developer starts Claude Code in multiple terminal sessions.
2. Each session generates events as work progresses.
3. Hooks send supported events to a local Node.js event receiver.
4. The receiver updates session state and persists relevant metadata.
5. The classifier evaluates events that may require attention.
6. The dashboard updates to show each session's status and priority.
7. The developer sees which session needs intervention, switches to the corresponding terminal, and resolves the issue.
8. New events update the dashboard and classification accordingly.

## 4. Functional requirements

### FR-1: Claude Code event collection

The application must capture relevant Claude Code lifecycle and notification events using the supported hook mechanism.

The implementation should investigate and configure the appropriate hooks for:

* Session start and initialization.
* User prompt submission.
* Tool execution failures or other relevant tool activity, where supported.
* Notifications, particularly permission requests and other interruptions.
* Assistant turn completion.
* Session termination or other lifecycle transitions, where available.

The implementation must use the actual event names, payload schemas, and exit-code behavior supported by the installed Claude Code version. It must not assume that every desired state has a dedicated hook event.

Each hook should invoke a lightweight local script or handler that forwards the event to the local event receiver. The forwarding mechanism must preserve the event payload and avoid logging sensitive contents unnecessarily.

**Requirements:**

* Configure hooks through the appropriate Claude Code settings mechanism.
* Keep hook handlers lightweight and time-bounded.
* Avoid blocking normal Claude Code operation if the monitoring service is unavailable.
* Handle malformed events without crashing the receiver.
* Make hook installation and removal straightforward.
* Include setup instructions for Linux.

### FR-2: Local event receiver

Implement a Node.js HTTP service that accepts hook events from local Claude Code sessions.

**Responsibilities:**

* Validate incoming event payloads.
* Normalize supported event types into a common internal format.
* Associate each event with its Claude Code session.
* Update the latest session state.
* Persist relevant state to SQLite.
* Trigger classification when appropriate.
* Broadcast state changes to the dashboard.

**Requirements:**

* Bind to the loopback interface by default.
* Use a configurable port.
* Provide a health-check endpoint.
* Reject malformed requests safely.
* Apply a configurable request-body size limit.
* Avoid exposing an unauthenticated event ingestion endpoint to the local network.
* Handle duplicate events and out-of-order arrivals as safely as practical.
* Keep event processing asynchronous where it would otherwise delay the hook response.

The receiver must acknowledge events promptly. AI inference must not run synchronously in the hook's request-response path.

### FR-3: Session tracking

The application must maintain a record for each observed Claude Code session.

A session record should include:

* Stable session identifier supplied by Claude Code, when available.
* First-seen and last-seen timestamps.
* Current inferred status.
* Last relevant event type.
* Last event timestamp.
* Current attention priority.
* Short explanation of why attention may be required.
* Confidence or uncertainty indicator for AI-generated classifications.
* Classification timestamp.
* Session lifecycle state, where it can be reliably determined.

The implementation must distinguish observed facts from inferred states. For example, a permission-request event is evidence of an interruption; the absence of new events alone does not prove that a session is blocked.

If an event does not contain a usable session identifier, the system should handle it safely and avoid incorrectly merging unrelated sessions.

### FR-4: Session state machine

Implement a deterministic state-management layer that derives a session's current state from observed events.

Initial status categories:

| Status          | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| Starting        | Session has started, but its current activity is not yet known.                          |
| Working         | Session appears to be actively processing a task.                                        |
| Needs attention | A permission request, question, or other actionable interruption has been detected.      |
| Error           | A relevant failure has been detected and may require intervention.                       |
| Completed       | The assistant turn has completed; the session may still be available for another prompt. |
| Idle / unknown  | Available evidence is insufficient to determine the current state.                       |
| Ended           | The session has ended, where this can be reliably detected.                              |

The state machine must use explicit events to drive transitions whenever possible. A completed assistant turn must not automatically be treated as a terminated session.

For stale sessions, the UI may display a last-seen indicator or stale-data warning rather than incorrectly asserting that the session is still working.

The implementation should document state transitions and their precedence, especially when delayed events arrive after newer events.

### FR-5: Attention classification

Use a locally hosted AI model to classify events or session summaries that are ambiguous or require contextual interpretation.

The classifier should answer:

1. Does this session need the developer's attention now?
2. What is the reason?
3. How urgent is the intervention?
4. What evidence supports the classification?
5. How confident is the classification?

Suggested priority levels:

| Priority | Meaning                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| Critical | A high-impact failure or interruption requires immediate intervention.            |
| High     | The session is explicitly waiting for user action, such as a permission decision. |
| Medium   | A question or unresolved issue may require a response soon.                       |
| Low      | No immediate intervention is necessary, but the session may be worth checking.    |
| None     | No actionable attention need has been identified.                                 |

Priority is an aid for sorting, not an authorization to perform actions automatically.

**Classification rules:**

* Use deterministic rules for unambiguous events, such as an explicit permission request.
* Use the local AI model for ambiguous notifications and contextual interpretation.
* Do not invoke the model for every tool call.
* Deduplicate repeated events to avoid repeatedly classifying the same interruption.
* Store the classification result and reuse it until relevant new information arrives.
* Provide a safe fallback when inference fails or times out.
* Never let an AI classification override reliable evidence that the session has ended.
* Show uncertainty instead of presenting an unsupported inference as fact.

The classifier should receive only the minimum event metadata and relevant text needed for the task. It must not require entire conversation transcripts or source files by default.

### FR-6: Local AI runtime

Integrate with a locally hosted model runtime, preferably Ollama, through its local API.

**Requirements:**

* Allow the model name to be configured.
* Provide a documented default model suitable for short text classification.
* Require structured output conforming to a defined schema.
* Validate all model responses before updating session priority.
* Apply a configurable inference timeout.
* Handle model unavailability, invalid output, and resource exhaustion.
* Avoid repeatedly loading or invoking the model for routine events.
* Make the deterministic classification path available even when no model is installed.

The model's output must be treated as untrusted data. It may influence the displayed classification but must never trigger shell commands, change permissions, or execute tools.

### FR-7: Live dashboard

Build a responsive local web dashboard using Next.js.

The dashboard should display all observed Claude Code sessions, ordered by attention priority and recency.

Each session card or row should show:

* Session identifier or recognizable label.
* Current status.
* Attention priority.
* Short reason for the current classification.
* Last relevant activity.
* Time since the latest event.
* Classification confidence or an uncertainty indicator, where available.
* A warning if the session data is stale or the monitoring service is disconnected.

**Dashboard behavior:**

* Update automatically when the receiver processes new events.
* Use Server-Sent Events (SSE) or another lightweight push mechanism for live updates.
* Provide a manual refresh or reconnection path.
* Clearly distinguish explicit states from AI-inferred states.
* Support filtering by status and priority.
* Display an empty state when no sessions have been detected.
* Display a useful degraded state if the local AI runtime is unavailable.
* Avoid exposing full prompt or tool-output contents by default.

The dashboard should be usable in an ordinary browser window without requiring native desktop packaging.

### FR-8: Session inspection

Selecting a session should reveal additional context, including:

* Recent relevant events.
* The reason for its current status.
* The latest classification and its evidence.
* Last-seen timestamp.
* Any relevant error or inference failure.

The event history should be bounded to avoid unbounded memory or storage growth.

The MVP does not need to open the correct terminal automatically. It should make it easy for the developer to identify the session they need to return to.

### FR-9: Configuration and diagnostics

Provide a simple configuration mechanism using environment variables or a local configuration file.

Configuration should cover:

* Event receiver host and port.
* Local model runtime URL.
* Model name.
* Classification timeout.
* Session staleness threshold.
* Event-history retention limits.
* Logging level.

Include diagnostics for:

* Receiver availability.
* Hook ingestion.
* SQLite availability.
* Local model connectivity.
* Most recent event received.
* Most recent classification error.

Provide clear setup, troubleshooting, and teardown instructions.

## 5. Non-functional requirements

### Performance

* Hook forwarding must be lightweight and time-bounded.
* The receiver must not wait for model inference before acknowledging an event.
* Routine events should avoid unnecessary model calls.
* Dashboard updates should appear promptly under normal local conditions.
* The app should remain usable if inference is slow or unavailable.

### Reliability

* A malformed event must not crash the service.
* A model failure must not prevent deterministic state updates.
* A monitoring-service outage must not intentionally block Claude Code work.
* The application must recover its persisted session metadata after a normal restart.
* Stale session information must be clearly indicated.

### Privacy and security

* Run the receiver on loopback by default.
* Keep event processing, persistence, and model inference local.
* Do not send prompts, source code, or session data to a cloud AI service.
* Minimize the capture and retention of potentially sensitive event text.
* Do not expose raw event payloads in normal dashboard views or logs.
* Validate requests and model output.
* Never execute model-generated shell commands or automatically approve permissions.

### Maintainability

* Use TypeScript across the application.
* Separate event ingestion, normalization, state management, classification, persistence, and dashboard presentation.
* Define explicit schemas for incoming events and classification results.
* Include unit tests for state transitions and classifier behavior.
* Keep the architecture simple enough to implement and demonstrate during a hackathon.

## 6. Technical architecture

### Components

1. **Claude Code hooks** — Capture supported lifecycle and notification events.
2. **Hook forwarding script** — Sends event payloads to the local receiver.
3. **Node.js event receiver** — Validates, normalizes, and processes events.
4. **Session state manager** — Maintains deterministic session status and attention metadata.
5. **SQLite database** — Persists session records and a bounded event history.
6. **Attention classifier** — Combines deterministic rules with local LLM classification.
7. **Local model runtime** — Runs the configured model through Ollama or a compatible local endpoint.
8. **Next.js dashboard** — Displays sessions and updates from the receiver.
9. **SSE endpoint** — Streams relevant state changes to connected dashboard clients.

### Event flow

1. Claude Code emits a supported hook event.
2. The hook handler forwards the payload to the local receiver.
3. The receiver validates and normalizes the event.
4. The session state manager applies deterministic transitions.
5. If the event warrants contextual classification, the classifier queues an inference request.
6. The classifier validates the model response and updates the session's attention metadata.
7. The database persists the updated state.
8. The receiver broadcasts the updated session to connected dashboards.
9. The developer identifies the session requiring attention and returns to its terminal.

The deterministic state update must not depend on successful AI inference.

### Suggested repository structure

```text
attention-manager/
├── apps/
│   └── dashboard/
│       ├── app/
│       ├── components/
│       └── lib/
├── packages/
│   └── core/
│       ├── events/
│       ├── sessions/
│       ├── classifier/
│       ├── persistence/
│       └── schemas/
├── services/
│   └── receiver/
│       ├── routes/
│       ├── ingestion/
│       └── server.ts
├── scripts/
│   ├── claude-hook.sh
│   └── setup-hooks.ts
├── tests/
├── .env.example
├── package.json
└── README.md
```

This is a suggested structure, not a requirement to create every directory. The coding agent may simplify it if a monorepo would add unnecessary complexity.

## 7. Data model

Use SQLite for local persistence.

### Session

| Field                       | Type               | Description                                            |
| --------------------------- | ------------------ | ------------------------------------------------------ |
| `session_id`                | TEXT, primary key  | Stable Claude Code session identifier, when available. |
| `label`                     | TEXT, nullable     | Human-readable session label.                          |
| `started_at`                | DATETIME, nullable | First observed session start.                          |
| `last_seen_at`              | DATETIME           | Timestamp of the latest accepted event.                |
| `last_event_type`           | TEXT, nullable     | Most recent normalized event type.                     |
| `status`                    | TEXT               | Current deterministic or inferred status.              |
| `priority`                  | TEXT               | Current attention priority.                            |
| `attention_reason`          | TEXT, nullable     | Concise explanation for the priority.                  |
| `classification_confidence` | REAL, nullable     | Validated confidence, if provided by the classifier.   |
| `classification_source`     | TEXT               | Rule-based, AI, or fallback.                           |
| `classified_at`             | DATETIME, nullable | Most recent classification timestamp.                  |
| `ended_at`                  | DATETIME, nullable | End timestamp when reliably known.                     |

### Session event

| Field         | Type                 | Description                                  |
| ------------- | -------------------- | -------------------------------------------- |
| `id`          | INTEGER, primary key | Internal event identifier.                   |
| `session_id`  | TEXT, nullable       | Associated session identifier.               |
| `event_type`  | TEXT                 | Normalized event type.                       |
| `occurred_at` | DATETIME             | Event timestamp, when available.             |
| `received_at` | DATETIME             | Receiver ingestion timestamp.                |
| `summary`     | TEXT, nullable       | Sanitized summary of relevant event content. |
| `dedupe_key`  | TEXT, nullable       | Key used to identify duplicate events.       |

Use indexes for session lookup, event recency, and deduplication where appropriate. Retain only a bounded number of events or a configurable retention window.

The exact schema may be adjusted to match the real hook payloads discovered during implementation.

## 8. Classifier contract

The classifier should return a validated structured object similar to:

```json
{
  "needs_attention": true,
  "priority": "high",
  "reason": "The session is waiting for a permission decision.",
  "evidence": [
    "A permission-request notification was observed."
  ],
  "confidence": 0.97
}
```

Allowed priorities are `critical`, `high`, `medium`, `low`, and `none`.

The implementation must validate the schema, allowed values, string lengths, and confidence range. The example is illustrative, not a claim about a particular model's actual accuracy.

### Classification strategy

**Stage 1: Deterministic rules**

Use explicit hook events and known lifecycle transitions to identify straightforward states. These rules should handle permission requests, reliable completion signals, and known error events wherever supported.

**Stage 2: AI classification**

Invoke the local model for ambiguous notifications or short event summaries that require semantic interpretation.

**Stage 3: Validation and fallback**

Reject invalid model output. If inference fails, preserve the deterministic session state and show that contextual classification is unavailable or uncertain.

Do not interpret a model's confidence score as a calibrated probability unless calibration has been independently established.

## 9. Why a local AI model is preferred

A local model is a good fit because this product monitors developer activity that can include source-code references, internal project names, prompts, tool errors, and other sensitive information.

### Benefits

* **Privacy:** Classification can happen without sending event text to an external AI provider.
* **Low marginal cost:** Repeated classification does not incur a per-request cloud API fee.
* **Offline operation:** Classification can continue without internet access once the runtime and model are installed.
* **Hackathon simplicity:** A local HTTP endpoint allows the Node.js application to integrate with the model without training a model or building an inference engine.
* **Control:** The developer chooses the model and can change it without redesigning the dashboard.

### Trade-offs

* **Hardware constraints:** Model inference competes with Claude Code and other development tools for CPU and memory.
* **Latency:** A larger model may be too slow for frequent attention classification.
* **Model quality:** Small models may struggle to distinguish subtle conversational states.
* **Setup:** The model runtime and model weights must be installed locally.
* **Resource usage:** Running inference alongside coding agents can degrade the development experience.

### Recommended approach

Use a small instruction-following model through Ollama, selected for structured classification rather than general-purpose coding. Keep inference inputs short and invoke the model only when deterministic rules are insufficient.

The product must remain useful without the model. Deterministic event handling should provide the core functionality, while local AI improves the interpretation and prioritization of ambiguous events.

## 10. MVP scope and prioritization

### P0 — Required for the demo

* [ ] Capture events from multiple Claude Code sessions.
* [ ] Receive events through a local Node.js HTTP service.
* [ ] Normalize and persist session state.
* [ ] Implement a deterministic state machine.
* [ ] Display all sessions in a web dashboard.
* [ ] Highlight permission requests and other clearly actionable interruptions.
* [ ] Implement local LLM classification for ambiguous events.
* [ ] Update the dashboard in near real time.
* [ ] Handle missing receiver, database, and model availability gracefully.
* [ ] Provide Linux setup and troubleshooting documentation.

### P1 — If time permits

* [ ] Filter and sort sessions by priority and status.
* [ ] Inspect recent events for a selected session.
* [ ] Add configurable retention and staleness thresholds.
* [ ] Add a session label or working-directory label when reliable metadata is available.
* [ ] Add a diagnostics panel and model health indicator.
* [ ] Improve deduplication and handling of delayed events.

### Out of scope for the hackathon MVP

* Automatic terminal focusing.
* Native desktop packaging.
* Cloud synchronization.
* Remote multi-machine monitoring.
* Automatic permission approvals or other autonomous actions.
* Historical analytics and productivity reports.
* Full transcript ingestion.

## 11. Acceptance criteria

The MVP is complete when all of the following are demonstrated:

1. Starting two or more Claude Code sessions results in separate session records when supported identifiers are available.
2. Relevant events from those sessions reach the local receiver and update the corresponding records.
3. An explicit permission request appears as an actionable attention item when its event is captured.
4. A completed assistant turn is not automatically treated as a terminated session.
5. The dashboard reflects accepted session updates without requiring a full page reload.
6. Ambiguous events can be classified using a locally hosted model.
7. Invalid model output or an unavailable model does not prevent deterministic state updates.
8. The dashboard displays the reason and source of each attention classification.
9. A receiver outage does not intentionally block Claude Code execution.
10. The application binds locally by default and does not require sending session data to a cloud AI service.
11. Restarting the application restores persisted session metadata.
12. Stale session data is identified rather than presented as unquestionably current.
13. Unit tests cover event normalization, state transitions, deduplication, and classifier validation.
14. A new developer can follow the README to install dependencies, configure hooks, start the receiver and dashboard, and run the demo.

## 12. Hackathon implementation sequence

### Phase 1: Validate the integration

* Inspect the installed Claude Code version and its hook documentation.
* Identify the actual event payloads available for session lifecycle, notifications, and completion.
* Configure a minimal hook that forwards one event to the local receiver.
* Verify that the hook does not interfere with normal Claude Code behavior.

**Deliverable:** A real Claude Code event reaches the receiver.

### Phase 2: Build the event pipeline

* Implement event validation and normalization.
* Implement session identity and deterministic state transitions.
* Add SQLite persistence and basic deduplication.
* Add tests for representative hook payloads.

**Deliverable:** Multiple sessions produce distinct, persisted states.

### Phase 3: Build the dashboard

* Implement the session list and priority ordering.
* Add the SSE endpoint and live dashboard updates.
* Add status, priority, recency, and stale-data indicators.

**Deliverable:** A usable dashboard with rule-based attention detection.

### Phase 4: Add local AI classification

* Integrate with the configured local model runtime.
* Define and validate the classifier's structured response.
* Invoke inference only for relevant ambiguous events.
* Add timeout handling, fallback behavior, and basic diagnostics.

**Deliverable:** AI-enhanced attention prioritization without dependence on cloud inference.

### Phase 5: Harden and demo

* Test concurrent sessions and rapid event arrival.
* Test receiver and model failures.
* Verify persistence and restart behavior.
* Document setup and teardown.
* Prepare a demo with several concurrent Claude Code sessions and a deliberately triggered permission request or other observable interruption.

**Deliverable:** A repeatable end-to-end demonstration.

## 13. Key risks and mitigations

| Risk                                           | Mitigation                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Hooks do not expose all desired session states | Base the MVP on verified event payloads and label uncertain states appropriately.                              |
| Local model inference is too slow              | Use a small model, short inputs, selective inference, and deterministic rules.                                 |
| Incorrect attention classifications            | Show evidence, distinguish inferred from observed states, and provide a fallback.                              |
| Events are duplicated or arrive out of order   | Deduplicate where possible and prevent older events from blindly overwriting newer state.                      |
| Monitoring interferes with Claude Code         | Keep handlers lightweight, bound execution time, and avoid synchronous inference.                              |
| Sensitive data is collected unnecessarily      | Minimize captured content, restrict local access, and bound retention.                                         |
| The project becomes too large for a hackathon  | Prioritize event ingestion, deterministic state, dashboard, and one local classifier before optional features. |

## 14. Open implementation decisions

The coding agent should resolve these during implementation rather than block the MVP:

* Which installed Claude Code hook events provide reliable session lifecycle and permission information?
* Which session metadata can be obtained reliably without inspecting terminal processes?
* Which small local model offers the best balance of inference speed, resource consumption, and classification quality on the developer's machine?
* Should the receiver and Next.js dashboard run in one Node.js process or as separate services? Prefer the simpler design that preserves clear boundaries.
* What event-history retention default provides useful debugging without accumulating sensitive data?

## 15. Instructions to the coding agent

Implement this PRD incrementally. Before writing the integration, inspect the current Claude Code hook documentation and verify event names, payloads, and execution semantics against the installed version.

Do not fabricate session states or assume an event exists when the hook system does not expose it. Prefer deterministic behavior over unnecessary AI calls. Keep the application local-first, minimize sensitive data collection, and ensure monitoring failures do not intentionally block normal coding work.

Start with a working end-to-end vertical slice: **one real hook event → local receiver → persisted session state → live dashboard update**. Once that works, add multi-session support, deterministic attention detection, and local AI classification.

The final deliverable must include source code, automated tests, environment configuration examples, and a README containing installation, hook setup, startup, troubleshooting, and teardown instructions.
