const HISTORY_LIMIT = 600;
const STREAM_TYPES = new Set([
    "assistant.reasoning_delta", "assistant.message_delta", "assistant.streaming_delta",
    "assistant.tool_call_delta", "tool.shell_output", "tool.execution_partial_result",
    "tool.execution_progress", "assistant.server_tool_progress",
]);
const CATEGORIES = new Set(["read", "write", "search", "think", "reply", "shell", "compact",
    "agent", "permission", "error", "done", "system"]);

function text(value, limit = 180) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, limit) : "";
}

function number(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function filePath(value) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").slice(0, 4096) : "";
}

function targetsFromArguments(args, kind) {
    const targets = [];
    const patch = typeof args === "string" ? args :
        typeof args?.patch === "string" ? args.patch : typeof args?.input === "string" ? args.input : null;
    if (patch && kind === "write") {
        for (const match of patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm)) {
            const operation = { "Add File": "create", "Update File": "edit", "Delete File": "delete", "Move to": "move" }[match[1]];
            targets.push({ path: filePath(match[2]), kind: operation });
        }
    } else if (args && typeof args === "object") {
        for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
            if (typeof args[key] === "string") targets.push({ path: filePath(args[key]), kind });
        }
        const paths = Array.isArray(args.paths) ? args.paths : typeof args.paths === "string" ? [args.paths] : [];
        for (const path of paths) {
            if (typeof path === "string") targets.push({ path: filePath(path), kind });
        }
    }
    return targets.filter((item, index) => item.path &&
        targets.findIndex((target) => target.path === item.path && target.kind === item.kind) === index);
}

function toolCategory(name, args) {
    const short = name.split(/[.:/]/).at(-1).toLowerCase();
    if (/^(view|read|read_file|get_file_contents|cat)$/.test(short) || short.startsWith("read_")) return "read";
    if (/^(apply_patch|edit|create|write|write_file|delete|str_replace_editor)$/.test(short)) {
        return args?.command === "view" ? "read" : "write";
    }
    if (/search|^rg$|^glob$|^grep$|^lsp$|find_file/.test(short)) return "search";
    if (/^(bash|shell|run|terminal|execute|read_bash|stop_bash)$/.test(short)) return "shell";
    return "system";
}

function label(kind) {
    return {
        read: "読込", write: "書換", search: "探索", think: "推論",
        reply: "生成", shell: "実行", compact: "圧縮",
        agent: "参戦", permission: "確認", error: "失敗",
        done: "完了", system: "始動",
    }[kind];
}

export function classifyEvent(event, tools = new Map()) {
    const data = event.data ?? {};
    const type = event.type;
    let kind = "system";
    let title = type;
    let detail = "";
    let impact = false;
    let phase = "notice";
    const meta = {};
    if (type === "tool.execution_start" || type === "tool.user_requested") {
        const name = text(data.toolName, 100) || "tool";
        kind = toolCategory(name, data.arguments);
        title = name;
        phase = "start";
        meta.targets = targetsFromArguments(data.arguments, kind);
        detail = text(meta.targets.map((item) => item.path).join(" · "));
        if (!detail && kind === "shell") {
            // Commands can contain credentials; retain only the executable, never arguments.
            const command = text(data.shellToolInfo?.displayCommand ?? data.arguments?.command);
            detail = command.match(/^\s*([a-zA-Z0-9_./-]+)(?:\s|$)/)?.[1] ?? "shell";
            meta.executable = detail;
        }
        meta.toolName = name;
        meta.toolCallId = text(data.toolCallId, 100);
        if (detail) meta.target = detail;
        impact = true;
    } else if (type === "tool.execution_complete") {
        const tool = tools.get(data.toolCallId);
        kind = data.success === false ? "error" : tool?.kind ?? "system";
        title = tool?.title ?? "tool";
        phase = data.success === false ? "failure" : data.success === true ? "success" : "finished";
        detail = data.success === false ? "実行に失敗" : "実行完了";
        meta.success = data.success;
        meta.toolCallId = text(data.toolCallId, 100);
        meta.toolName = tool?.title ?? "tool";
        if (tool?.executable) meta.executable = tool.executable;
        meta.targets = tool?.targets ?? [];
        if (Array.isArray(data.fileEdits) && data.fileEdits.length) {
            meta.files = data.fileEdits.map((edit) => ({
                kind: text(edit.kind, 30), path: filePath(edit.path),
            }));
            kind = data.success === false ? "error" : "write";
            detail = `${data.fileEdits.length}件のファイル変更を確認`;
            meta.partial = data.success === false;
        }
        impact = ["error", "write", "read", "search", "shell"].includes(kind);
    } else if (type === "session.compaction_start" || type === "session.compaction_complete") {
        kind = data.success === false ? "error" : "compact";
        phase = type.endsWith("_start") ? "start" : data.success === true ? "success" : "failure";
        title = type.endsWith("_start") ? "コンテキスト圧縮 開始" :
            data.success === false ? "コンテキスト圧縮 失敗" : "コンテキスト圧縮 完了";
        meta.trigger = text(data.trigger, 60);
        const before = number(data.preCompactionTokens ?? data.currentTokens);
        const after = number(data.postCompactionTokens);
        if (before !== null) meta.before = before;
        if (after !== null) meta.after = after;
        detail = before !== null && after !== null ? `${before.toLocaleString()} → ${after.toLocaleString()} tokens` :
            before !== null ? `${before.toLocaleString()} tokens` : meta.trigger;
        impact = true;
    } else if (type === "assistant.reasoning" || type === "assistant.reasoning_delta" || type === "assistant.turn_start") {
        kind = "think";
        phase = type === "assistant.turn_start" ? "start" : "progress";
        title = "推論・応答準備";
        detail = "公開された推論イベントを受信";
    } else if (type === "model.call_start" || type === "model.model_call_started") {
        kind = "think";
        phase = "start";
        title = "モデル呼び出し 開始";
        detail = "推論・応答を待機";
        impact = type === "model.call_start";
    } else if (type === "assistant.streaming_delta" || type === "assistant.tool_call_delta") {
        kind = "think";
        phase = "progress";
        title = type === "assistant.tool_call_delta" ? "ツール呼び出しを組み立て中" : "モデルからストリーミング受信";
        detail = "本文・引数は収集しません";
        if (number(data.totalResponseSizeBytes) !== null) meta.responseBytes = data.totalResponseSizeBytes;
    } else if (type === "tool.shell_output" || type === "tool.execution_partial_result" ||
        type === "tool.execution_progress") {
        const tool = tools.get(data.toolCallId);
        kind = type === "tool.shell_output" ? "shell" : tool?.kind ?? "system";
        phase = "progress";
        title = type === "tool.shell_output" ? "コマンド出力を受信" : "ツールの途中経過を受信";
        detail = tool?.title ?? "出力本文は収集しません";
    } else if (type === "assistant.message" || type === "assistant.message_start" || type === "assistant.message_delta") {
        kind = "reply";
        phase = type === "assistant.message" ? "finished" : "progress";
        title = "応答を生成";
        detail = "応答本文は収集しません";
    } else if (type === "assistant.intent") {
        kind = "think";
        phase = "progress";
        title = "次の動作を準備";
        detail = "エージェントの動作通知を受信";
    } else if (type.startsWith("subagent.")) {
        kind = type.endsWith("failed") ? "error" : type.endsWith("completed") ? "done" : "agent";
        phase = data.cancelled ? "cancelled" : type.endsWith("failed") ? "failure" :
            type.endsWith("completed") ? "success" : type.endsWith("started") ? "start" : "notice";
        title = text(data.agentDisplayName ?? data.agentName ?? data.agentType, 100) || "サブエージェント";
        meta.agentName = title;
        detail = type.endsWith("started") ? "サブエージェントが参加" :
            type.endsWith("completed") ? "サブエージェントの処理完了" : type;
        impact = /started|completed|failed/.test(type);
    } else if (type === "session.error" || type === "model.call_failure" || type.endsWith(".failed")) {
        kind = "error";
        phase = "failure";
        title = "処理エラー";
        detail = text(data.errorType ?? data.errorCode, 80) || type;
        impact = true;
    } else if (/^(permission|user_input|elicitation)\.requested$/.test(type)) {
        kind = "permission";
        phase = "waiting";
        title = "確認・入力待ち";
        detail = type;
        impact = true;
    } else if (/^(permission|user_input|elicitation)\.completed$/.test(type)) {
        kind = "permission";
        phase = "finished";
        title = "確認・入力を受信";
    } else if (type === "session.task_complete") {
        const accepted = data.success === true && !data.blocker;
        kind = accepted ? "done" : data.success === false ? "error" : "system";
        phase = accepted ? "success" : data.success === false ? "failure" : "finished";
        title = accepted ? "タスク完了" : data.success === false ? "完了判定が不成立" : "タスク終了通知";
        meta.success = accepted;
        meta.outcome = text(data.outcome, 40);
        impact = true;
    } else if (type === "session.idle") {
        kind = "done";
        phase = data.aborted ? "cancelled" : "idle";
        title = data.aborted ? "処理を中断" : "待機";
    } else if (type === "abort") {
        kind = "done";
        phase = "cancelled";
        title = "処理を中断";
        impact = true;
    } else if (type === "assistant.usage" || type === "session.usage_info") {
        title = "使用量を更新";
        for (const key of ["inputTokens", "outputTokens", "currentTokens", "tokenLimit", "duration", "outputTtftMs"]) {
            const value = number(data[key]);
            if (value !== null) meta[key] = value;
        }
    } else if (type === "model.call_finished") {
        title = "モデル呼び出し完了";
        phase = "finished";
        detail = text(data.outcome, 60);
        meta.durationMs = number(data.dispatchDurationMs);
    } else if (type === "session.workspace_file_changed") {
        const ownStorage = data.path?.startsWith("copilot-arcade/");
        kind = ownStorage ? "system" : "write";
        phase = ownStorage ? "notice" : "success";
        title = ownStorage ? "実況の履歴を保存" : "セッション成果物を更新";
        detail = filePath(data.path);
        if (!ownStorage && detail) meta.files = [{ path: detail, kind: text(data.operation, 30) }];
        impact = !ownStorage;
    } else if (type === "user.message") {
        title = "ユーザー指示を受信";
        phase = "start";
        impact = true;
    }
    if (STREAM_TYPES.has(type)) impact = false;
    return { kind, phase, label: label(kind), title, detail, meta, impact, stream: STREAM_TYPES.has(type) };
}

export class EventMonitor {
    constructor() {
        this.sessionId = "";
        this.sequence = 0;
        this.events = [];
        this.types = Object.create(null);
        this.stats = { tools: 0, files: 0, failures: 0, compactions: 0, agents: 0,
            inputTokens: 0, outputTokens: 0, deltas: 0 };
        this.active = new Map();
        this.tools = new Map();
        this.streamGroups = new Map();
        this.seen = new Set();
        this.currentTokens = null;
        this.tokenLimit = null;
        this.storageError = null;
        this.lastImpact = null;
        this.status = "待機中";
        this.restored = false;
    }

    receive(event) {
        if (typeof event?.type !== "string" || typeof event.id !== "string") {
            throw new TypeError("Invalid SDK session event.");
        }
        if (this.seen.has(event.id)) return false;
        this.seen.add(event.id);
        if (this.seen.size > 3000) this.seen.delete(this.seen.values().next().value);
        const data = event.data ?? {};
        const info = classifyEvent(event, this.tools);
        const item = { ...info, id: event.id, type: event.type, timestamp: event.timestamp,
            agent: text(event.agentId, 100) || "main", sequence: ++this.sequence, count: 1 };
        this.types[event.type] = (this.types[event.type] ?? 0) + 1;
        if (info.stream) this.stats.deltas++;
        const streamKey = JSON.stringify([item.agent, item.type, data.toolCallId ?? data.reasoningId ?? data.messageId ?? ""]);
        const grouped = info.stream ? this.streamGroups.get(streamKey) : null;
        if (!info.stream) this.streamGroups.clear();
        if (grouped && Date.parse(item.timestamp) - Date.parse(grouped.timestamp) < 2000) {
            grouped.count++;
            grouped.sequence = item.sequence;
            grouped.timestamp = item.timestamp;
            grouped.id = item.id;
            grouped.meta = item.meta;
            this.events.splice(this.events.indexOf(grouped), 1);
            this.events.push(grouped);
        } else {
            this.events.push(item);
            if (info.stream) this.streamGroups.set(streamKey, item);
            if (this.events.length > HISTORY_LIMIT) {
                const removed = this.events.shift();
                for (const [key, group] of this.streamGroups) {
                    if (group === removed) this.streamGroups.delete(key);
                }
            }
        }
        if (info.impact) this.lastImpact = item;
        const agent = item.agent;
        const id = data.toolCallId;
        if (event.type === "tool.execution_start") {
            this.stats.tools++;
            const tool = { id, agent, kind: info.kind, title: info.title, detail: info.detail,
                targets: info.meta.targets, executable: info.meta.executable, started: item.timestamp };
            this.tools.set(id, tool);
            this.active.delete(`model:${agent}`);
            this.active.set(`tool:${id}`, tool);
            this.status = "ツール実行中";
        } else if (event.type === "tool.execution_complete") {
            this.active.delete(`tool:${id}`);
            this.tools.delete(id);
            if (data.success === false) this.stats.failures++;
            this.stats.files += Array.isArray(data.fileEdits) ? data.fileEdits.length : 0;
            this.status = this.active.size ? "処理進行中" : "次の動作を待機";
        } else if (event.type === "assistant.turn_start" || event.type === "model.call_start") {
            this.active.set(`model:${agent}`, {
                id: `model:${agent}`, agent, kind: "think", title: "モデル応答待ち", detail: "",
                started: item.timestamp,
            });
            this.status = "推論・応答準備中";
        } else if (/^assistant\.(reasoning_delta|message_start|message_delta)$/.test(event.type)) {
            this.active.set(`model:${agent}`, {
                id: `model:${agent}`, agent, kind: info.kind, title: info.title, detail: "",
                started: this.active.get(`model:${agent}`)?.started ?? item.timestamp,
            });
            this.status = info.kind === "think" ? "推論中" : "応答生成中";
        } else if (event.type === "model.call_finished" || event.type === "assistant.turn_end" ||
            event.type === "assistant.idle") {
            this.active.delete(`model:${agent}`);
            this.status = this.active.size ? "処理進行中" : "次の動作を待機";
        } else if (event.type === "session.compaction_start") {
            this.active.set(`compact:${agent}`, {
                id: `compact:${agent}`, agent, kind: "compact", title: "コンテキスト圧縮",
                detail: info.detail, started: item.timestamp,
            });
            this.status = "コンテキスト圧縮中";
        } else if (event.type === "session.compaction_complete") {
            this.active.delete(`compact:${agent}`);
            if (data.success) this.stats.compactions++;
            else this.stats.failures++;
            if (number(data.postCompactionTokens) !== null) this.currentTokens = data.postCompactionTokens;
            this.status = this.active.size ? "処理進行中" : "圧縮完了";
        } else if (event.type === "subagent.started") {
            this.stats.agents++;
            const key = data.toolCallId ?? data.agentId ?? event.agentId ?? event.id;
            this.active.set(`agent:${key}`, {
                id: `agent:${key}`, agent: text(key, 100), kind: "agent",
                title: info.title, detail: "", started: item.timestamp,
            });
        } else if (event.type === "subagent.completed" || event.type === "subagent.failed") {
            const key = data.toolCallId ?? data.agentId ?? event.agentId;
            if (key) {
                this.active.delete(`agent:${key}`);
                for (const [entryKey, activity] of this.active) {
                    if (activity.agent === key) this.active.delete(entryKey);
                }
            }
            if (event.type === "subagent.failed") this.stats.failures++;
            this.status = this.active.size ? "処理進行中" : "次の動作を待機";
        } else if (event.type === "session.task_complete") {
            for (const [key, activity] of this.active) {
                if (activity.agent === agent && key.startsWith("model:")) this.active.delete(key);
            }
            this.status = info.meta.success ? "タスク完了" : data.success === false ? "完了判定不成立" : "タスク終了通知";
        } else if (event.type === "session.usage_info") {
            this.currentTokens = number(data.currentTokens);
            this.tokenLimit = number(data.tokenLimit);
        } else if (event.type === "assistant.usage") {
            this.stats.inputTokens += number(data.inputTokens) ?? 0;
            this.stats.outputTokens += number(data.outputTokens) ?? 0;
        } else if (event.type === "session.idle" || event.type === "abort") {
            for (const [key, activity] of this.active) {
                if (activity.agent === agent) this.active.delete(key);
            }
            for (const [key, tool] of this.tools) {
                if (tool.agent === agent) this.tools.delete(key);
            }
            this.status = this.active.size ? "バックグラウンド処理中" :
                event.type === "abort" || data.aborted ? "中断・待機中" : "待機中";
        } else if (event.type === "session.error" || event.type === "model.call_failure") {
            this.stats.failures++;
            this.active.delete(`model:${agent}`);
            this.status = "エラーを受信";
        } else if (info.kind === "permission") {
            const key = `permission:${data.requestId ?? event.id}`;
            if (event.type.endsWith("requested")) {
                this.active.set(key, {
                    id: key, agent, kind: "permission", title: "確認", detail: "", started: item.timestamp,
                });
            } else {
                this.active.delete(key);
            }
            this.status = event.type.endsWith("requested") ? "確認・入力待ち" : "処理進行中";
        }
        return true;
    }

    view() {
        return {
            sessionId: this.sessionId, sequence: this.sequence, events: this.events,
            types: this.types, stats: this.stats, active: [...this.active.values()],
            currentTokens: this.currentTokens, tokenLimit: this.tokenLimit,
            storageError: this.storageError, lastImpact: this.lastImpact, status: this.status,
            restored: this.restored, historyLimit: HISTORY_LIMIT,
        };
    }

    snapshot() {
        return { version: 1, ...this.view() };
    }
}

export function restoreSnapshot(monitor, saved) {
    if (saved.version !== 1 || saved.sessionId !== monitor.sessionId ||
        !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || !Array.isArray(saved.events) ||
        !saved.types || typeof saved.types !== "object" || !saved.stats ||
        Object.keys(monitor.stats).some((key) => number(saved.stats[key]) === null) ||
        Object.values(saved.types).some((value) => number(value) === null) ||
        saved.events.some((event) => typeof event.id !== "string" || typeof event.type !== "string" ||
            !CATEGORIES.has(event.kind) || !Number.isSafeInteger(event.sequence) ||
            typeof event.timestamp !== "string" || typeof event.title !== "string")) {
        throw new Error("DopaCopa history has an unsupported or invalid format.");
    }
    monitor.sequence = saved.sequence;
    monitor.events = saved.events.slice(-HISTORY_LIMIT);
    monitor.types = Object.assign(Object.create(null), saved.types);
    monitor.stats = { ...saved.stats };
    monitor.currentTokens = number(saved.currentTokens);
    monitor.tokenLimit = number(saved.tokenLimit);
    monitor.lastImpact = saved.lastImpact ?? null;
    monitor.seen = new Set(monitor.events.map((event) => event.id));
    monitor.restored = true;
    // Activity from a disconnected provider is not evidence that a tool is still running.
    monitor.status = "再接続・新しいイベントを待機";
}
