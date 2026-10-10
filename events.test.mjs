import test from "node:test";
import assert from "node:assert/strict";
import { EventMonitor, classifyEvent, restoreSnapshot } from "./events.mjs";

let nextId = 0;
function event(type, data = {}, extra = {}) {
    return { id: `event-${++nextId}`, type, data, timestamp: new Date().toISOString(), ...extra };
}

test("every event type is counted, including unknown events and grouped streaming chunks", () => {
    const monitor = new EventMonitor();
    for (let i = 0; i < 1000; i++) monitor.receive(event("assistant.reasoning_delta", { deltaContent: "PRIVATE" }));
    monitor.receive(event("future.unknown_event", { password: "SECRET" }));
    assert.equal(monitor.sequence, 1001);
    assert.equal(monitor.types["assistant.reasoning_delta"], 1000);
    assert.equal(monitor.types["future.unknown_event"], 1);
    assert.equal(monitor.events[0].count, 1000);
    assert.equal(monitor.events.at(-1).kind, "system");
    assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /PRIVATE|SECRET/);
});

test("alternating stream types do not evict meaningful file events", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("tool.execution_start", {
        toolName: "view", toolCallId: "file-read", arguments: { path: "/project/important.ts" },
    }));
    monitor.receive(event("tool.execution_complete", { toolCallId: "file-read", success: true }));
    for (let i = 0; i < 2000; i++) {
        monitor.receive(event("assistant.streaming_delta", { totalResponseSizeBytes: i }));
        monitor.receive(event("assistant.tool_call_delta"));
    }
    assert.equal(monitor.events.length, 4);
    assert.equal(monitor.sequence, 4002);
    assert.equal(monitor.events[0].meta.targets[0].path, "/project/important.ts");
    assert.equal(monitor.events[1].meta.success, true);
    assert.equal(monitor.events[2].meta.responseBytes, 1999);
    assert.equal(monitor.events[2].count, 2000);
    assert.equal(monitor.events[3].count, 2000);
    assert.ok(monitor.events.every((item, index, all) => !index || item.sequence > all[index - 1].sequence));
});

test("read, search and view-only editing commands are classified without retaining content", () => {
    assert.equal(classifyEvent(event("tool.execution_start", { toolName: "view", arguments: { path: "a.ts" } })).kind, "read");
    assert.equal(classifyEvent(event("tool.execution_start", { toolName: "functions.rg" })).kind, "search");
    assert.equal(classifyEvent(event("tool.execution_start", { toolName: "str_replace_editor", arguments: { command: "view" } })).kind, "read");
    const result = classifyEvent(event("tool.execution_start", {
        toolName: "bash", arguments: { command: "curl --header 'Authorization: secret-token' https://example.com" },
    }));
    assert.equal(result.kind, "shell");
    assert.equal(result.detail, "curl");
    assert.doesNotMatch(JSON.stringify(result), /secret-token|Authorization/);
});

test("parallel tools correlate by ID and partial-failure file edits are counted as committed changes", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("tool.execution_start", { toolName: "view", toolCallId: "read-1", arguments: { path: "a.ts" } }));
    monitor.receive(event("tool.execution_start", { toolName: "apply_patch", toolCallId: "write-1" }));
    assert.equal(monitor.active.size, 2);
    monitor.receive(event("tool.execution_complete", { toolCallId: "read-1", success: true }));
    assert.equal(monitor.active.size, 1);
    assert.equal(monitor.events.at(-1).title, "view");
    monitor.receive(event("tool.execution_complete", {
        toolCallId: "write-1", success: false, fileEdits: [{ kind: "edit", path: "b.ts" }],
    }));
    assert.equal(monitor.active.size, 0);
    assert.equal(monitor.stats.tools, 2);
    assert.equal(monitor.stats.files, 1);
    assert.equal(monitor.stats.failures, 1);
    assert.equal(monitor.lastImpact.kind, "error");
});

test("compaction success, failure and zero token values reflect real outcomes", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("session.compaction_start", { currentTokens: 100000, tokenLimit: 128000 }));
    assert.equal(monitor.status, "コンテキスト圧縮中");
    monitor.receive(event("session.compaction_complete", {
        success: true, preCompactionTokens: 100000, postCompactionTokens: 0,
        summaryContent: "PRIVATE SUMMARY",
    }));
    assert.equal(monitor.stats.compactions, 1);
    assert.equal(monitor.currentTokens, 0);
    assert.match(monitor.lastImpact.detail, /100,000 → 0/);
    monitor.receive(event("session.compaction_complete", { success: false }));
    assert.equal(monitor.stats.compactions, 1);
    assert.equal(monitor.stats.failures, 1);
    assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /PRIVATE SUMMARY/);
});

test("bounded history preserves counters, restores safely, and does not resurrect stale activity", () => {
    const monitor = new EventMonitor();
    monitor.sessionId = "test-session";
    for (let i = 0; i < 900; i++) monitor.receive(event("custom.event"));
    monitor.receive(event("tool.execution_start", { toolName: "view", toolCallId: "running" }));
    const restored = new EventMonitor();
    restored.sessionId = "test-session";
    restoreSnapshot(restored, JSON.parse(JSON.stringify(monitor.snapshot())));
    assert.equal(restored.events.length, 600);
    assert.equal(restored.sequence, 901);
    assert.equal(restored.types["custom.event"], 900);
    assert.equal(restored.active.size, 0);
    assert.equal(restored.restored, true);
    assert.equal(restored.receive(monitor.events.at(-1)), false);
    assert.throws(() => restoreSnapshot(restored, { version: 999 }), /invalid format/);
    assert.throws(() => restoreSnapshot(restored, { ...monitor.snapshot(), sessionId: "other-session" }), /invalid format/);
});

test("session idle clears activity and usage numbers are not fabricated", () => {
    const monitor = new EventMonitor();
    assert.equal(monitor.currentTokens, null);
    monitor.receive(event("assistant.turn_start"));
    monitor.receive(event("session.usage_info", { currentTokens: 8000, tokenLimit: 128000 }));
    monitor.receive(event("assistant.usage", { inputTokens: 120, outputTokens: 40, model: "test-model" }));
    monitor.receive(event("session.idle"));
    assert.equal(monitor.active.size, 0);
    assert.equal(monitor.status, "待機中");
    assert.equal(monitor.stats.inputTokens, 120);
    assert.equal(monitor.stats.outputTokens, 40);
    assert.equal(monitor.currentTokens, 8000);
});

test("foreground idle preserves background agents and their running tools", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("subagent.started", { toolCallId: "spawn-1", agentDisplayName: "Builder" }));
    monitor.receive(event("tool.execution_start", { toolName: "bash", toolCallId: "child-tool" }, { agentId: "child-1" }));
    monitor.receive(event("session.idle"));
    assert.equal(monitor.active.size, 2);
    assert.equal(monitor.status, "バックグラウンド処理中");
    monitor.receive(event("tool.execution_complete", { toolCallId: "child-tool", success: true }, { agentId: "child-1" }));
    monitor.receive(event("subagent.completed", { toolCallId: "spawn-1" }));
    assert.equal(monitor.active.size, 0);
});

test("target files survive start/completion correlation, including long paths", () => {
    const monitor = new EventMonitor();
    const path = `/project/${"long-directory/".repeat(24)}実際のファイル.ts`;
    monitor.receive(event("tool.execution_start", { toolName: "view", toolCallId: "reader", arguments: { path } }));
    const start = monitor.events.at(-1);
    assert.equal(start.phase, "start");
    assert.equal(start.meta.targets[0].path, path);
    monitor.receive(event("tool.execution_complete", { toolCallId: "reader", success: true }));
    const complete = monitor.events.at(-1);
    assert.equal(complete.phase, "success");
    assert.equal(complete.kind, "read");
    assert.equal(complete.meta.targets[0].path, path);
    assert.equal(complete.impact, true);
});

test("freeform patches expose only file headers, including move destinations", () => {
    const result = classifyEvent(event("tool.execution_start", {
        toolName: "apply_patch",
        arguments: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-SECRET BODY\n+PRIVATE BODY\n*** Add File: second.ts\n+PRIVATE\n*** End Patch",
    }));
    assert.deepEqual(result.meta.targets.map((file) => file.path), ["old.ts", "new.ts", "second.ts"]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE/);
});

test("only accepted task completion is success, not idle, rejected completion, or cancellation", () => {
    assert.equal(classifyEvent(event("session.idle")).phase, "idle");
    assert.equal(classifyEvent(event("abort")).phase, "cancelled");
    assert.equal(classifyEvent(event("session.task_complete", { success: false })).phase, "failure");
    assert.equal(classifyEvent(event("session.task_complete", { summary: "finished" })).phase, "finished");
    assert.equal(classifyEvent(event("session.task_complete", { success: true })).phase, "success");
    assert.equal(classifyEvent(event("subagent.completed", { cancelled: true })).phase, "cancelled");
});

test("late complete reasoning notifications do not resurrect a finished model call", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("model.call_start"));
    assert.equal(monitor.active.size, 1);
    monitor.receive(event("model.call_finished", { dispatchDurationMs: 10 }));
    monitor.receive(event("assistant.reasoning", { content: "PRIVATE" }));
    assert.equal(monitor.active.size, 0);
    monitor.receive(event("tool.execution_start", { toolName: "bash", toolCallId: "shell", arguments: { command: "node --version" } }));
    monitor.receive(event("tool.execution_complete", { toolCallId: "shell", success: true }));
    assert.equal(monitor.events.at(-1).meta.executable, "node");
});

test("input prompts are dismissed by request ID without removing concurrent prompts", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("user_input.requested", { requestId: "first", question: "PRIVATE" }));
    monitor.receive(event("permission.requested", { requestId: "second" }));
    assert.equal(monitor.active.size, 2);
    monitor.receive(event("user_input.completed", { requestId: "first", answer: "PRIVATE" }));
    assert.equal(monitor.active.size, 1);
    monitor.receive(event("permission.completed", { requestId: "second" }));
    assert.equal(monitor.active.size, 0);
    assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /PRIVATE/);
});
