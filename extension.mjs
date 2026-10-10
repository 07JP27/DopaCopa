import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { EventMonitor, restoreSnapshot } from "./events.mjs";
import { SoundEngine } from "./stage.mjs";

const html = await readFile(new URL("./renderer.html", import.meta.url), "utf8");
const stageModule = await readFile(new URL("./stage.mjs", import.meta.url), "utf8");
const audioAssets = new Map(await Promise.all(SoundEngine.files.map(async (name) =>
    [name, await readFile(new URL(`./sounds/${name}`, import.meta.url))])));
const monitor = new EventMonitor();
const servers = new Map();
let session;
let storagePath;
let initialized = false;
let saveTimer;
let saveWork = Promise.resolve();
const startupEvents = [];

function receive(event) {
    if (!initialized) {
        startupEvents.push(event);
        return;
    }
    if (monitor.receive(event) && !(event.type === "session.workspace_file_changed" &&
        event.data?.path?.startsWith("copilot-arcade/"))) scheduleSave();
}

function scheduleSave() {
    if (saveTimer || !storagePath) return;
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        saveWork = saveWork.then(async () => {
            const snapshot = JSON.stringify(monitor.snapshot());
            await writeFile(`${storagePath}.tmp`, snapshot, { mode: 0o600 });
            await rename(`${storagePath}.tmp`, storagePath);
            monitor.storageError = null;
        }).catch((error) => {
            monitor.storageError = `履歴の保存に失敗: ${error.message}`;
            console.error("[DopaCopa] Snapshot persistence failed:", error);
        });
    }, 1000);
    saveTimer.unref();
}

function sendJson(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
}

function sse(res, name, value) {
    return res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function startServer() {
    const token = randomBytes(24).toString("hex");
    const clients = new Set();
    const sockets = new Set();
    let lastSequence = -1;
    let lastStorageError;
    let audioStatus = null;
    const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        const url = new URL(req.url, "http://127.0.0.1");
        const expectedHost = `127.0.0.1:${server.address().port}`;
        if (req.headers.host !== expectedHost || url.searchParams.get("token") !== token) {
            sendJson(res, 403, { error: "Canvas access denied." });
            return;
        }
        if (req.method === "POST" && url.pathname === "/audio-status") {
            const expectedOrigin = `http://${expectedHost}`;
            if (req.headers.origin && req.headers.origin !== expectedOrigin) {
                sendJson(res, 403, { error: "Audio status origin denied." });
                return;
            }
            let body = "";
            req.setEncoding("utf8");
            req.on("data", (chunk) => {
                if (res.writableEnded) return;
                body += chunk;
                if (body.length > 2048) {
                    sendJson(res, 413, { error: "Audio status is too large." });
                    req.destroy();
                }
            });
            req.on("end", () => {
                if (res.writableEnded) return;
                try {
                    const data = JSON.parse(body);
                    if (!["ready", "blocked", "muted", "paused", "error"].includes(data.state) ||
                        !["uninitialized", "running", "suspended", "interrupted", "closed"].includes(data.contextState) ||
                        !Number.isFinite(data.peak) || data.peak < 0 || data.peak > 10 ||
                        !Number.isFinite(data.gain) || data.gain < 0 || data.gain > 1 ||
                        !Number.isInteger(data.voices) || data.voices < 0 || data.voices > 20 ||
                        typeof data.error !== "string" || data.error.length > 500) {
                        sendJson(res, 400, { error: "Invalid audio status." });
                        return;
                    }
                    audioStatus = {
                        state: data.state, contextState: data.contextState, peak: data.peak,
                        gain: data.gain, voices: data.voices, error: data.error, reportedAt: new Date().toISOString(),
                    };
                    sendJson(res, 200, { recorded: true });
                } catch (error) {
                    console.error("[DopaCopa] Invalid audio status:", error.message);
                    sendJson(res, 400, { error: "Invalid audio status JSON." });
                }
            });
            req.on("error", (error) => console.error("[DopaCopa] Audio status request failed:", error.message));
            return;
        }
        if (req.method !== "GET") {
            res.setHeader("Allow", "GET");
            sendJson(res, 405, { error: "Read-only Canvas." });
            return;
        }
        if (url.pathname === "/") {
            res.setHeader("Content-Security-Policy",
                "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
                "connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        } else if (url.pathname === "/state") {
            sendJson(res, 200, monitor.view());
        } else if (url.pathname === "/stage.mjs") {
            res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
            res.end(stageModule);
        } else if (url.pathname.startsWith("/sounds/")) {
            const asset = audioAssets.get(url.pathname.slice("/sounds/".length));
            if (!asset) {
                sendJson(res, 404, { error: "Sound asset not found." });
                return;
            }
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": asset.length });
            res.end(asset);
        } else if (url.pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.write("retry: 1500\n\n");
            sse(res, "snapshot", monitor.view());
            clients.add(res);
            res.on("close", () => clients.delete(res));
            res.on("error", (error) => {
                console.error("[DopaCopa] SSE connection failed:", error.message);
                clients.delete(res);
                res.destroy();
            });
        } else {
            sendJson(res, 404, { error: "Not found." });
        }
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    server.on("error", (error) => {
        console.error("[DopaCopa] HTTP server failed:", error);
        monitor.storageError = `Canvasサーバーエラー: ${error.message}`;
    });
    const ticker = setInterval(() => {
        if (!clients.size) return;
        if (lastSequence === monitor.sequence && lastStorageError === monitor.storageError) return;
        lastSequence = monitor.sequence;
        lastStorageError = monitor.storageError;
        const state = monitor.view();
        for (const client of clients) {
            if (client.writableLength > 512 * 1024) {
                clients.delete(client);
                client.destroy();
            } else {
                // write() returning false signals backpressure, not a failed connection.
                sse(client, "snapshot", state);
            }
        }
    }, 250);
    const heartbeat = setInterval(() => {
        for (const client of clients) client.write(": heartbeat\n\n");
    }, 15000);
    ticker.unref();
    heartbeat.unref();
    return {
        url: `http://127.0.0.1:${server.address().port}/?token=${token}&scoutTheme=dark`,
        getAudioStatus: () => audioStatus,
        async close() {
            clearInterval(ticker);
            clearInterval(heartbeat);
            for (const client of clients) client.end();
            const closed = new Promise((resolve, reject) =>
                server.close((error) => error ? reject(error) : resolve()));
            for (const socket of sockets) socket.destroy();
            await closed;
        },
    };
}

const canvas = createCanvas({
    id: "copilot-arcade",
    displayName: "DopaCopa",
    description: "Read-only live arcade visualization of this session's Copilot events, tool activity and compaction.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    open: async (ctx) => {
        if (!initialized) throw new CanvasError("observer_starting", "Event observer is still initializing.");
        if (ctx.sessionId !== session.sessionId) {
            throw new CanvasError("session_mismatch", "This observer belongs to another session.");
        }
        if (!servers.has(ctx.instanceId)) {
            const pending = startServer().catch((error) => {
                servers.delete(ctx.instanceId);
                throw error;
            });
            servers.set(ctx.instanceId, pending);
        }
        const entry = await servers.get(ctx.instanceId);
        return { title: "DopaCopa", url: entry.url };
    },
    actions: [
        {
            name: "get_status",
            description: "Read live observer counters, received event types, current activity and persistence status.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => {
                const state = monitor.view();
                const audio = [];
                for (const [instanceId, pending] of servers) {
                    audio.push({ instanceId, ...(await pending).getAudioStatus() });
                }
                return { ...state, events: state.events.slice(-8), audio };
            },
        },
        {
            name: "get_recent_events",
            description: "Read the recent privacy-preserving event timeline. Streaming chunks are grouped; no reasoning text or file contents are collected.",
            inputSchema: {
                type: "object",
                properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
                additionalProperties: false,
            },
            handler: (ctx) => monitor.view().events.slice(-(ctx.input?.limit ?? 30)),
        },
    ],
    onClose: async (ctx) => {
        const pending = servers.get(ctx.instanceId);
        if (pending) {
            servers.delete(ctx.instanceId);
            await (await pending).close();
        }
    },
});

session = await joinSession({
    canvases: [canvas],
    streaming: true,
    includeSubAgentStreamingEvents: true,
    onEvent: receive,
});
monitor.sessionId = session.sessionId;
if (session.workspacePath) {
    const directory = join(session.workspacePath, "files", "copilot-arcade");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    storagePath = join(directory, "state.json");
    let saved;
    try {
        saved = await readFile(storagePath, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (saved !== undefined) restoreSnapshot(monitor, JSON.parse(saved));
} else {
    monitor.storageError = "SDKから保存先が提供されていません。履歴はこのプロセス内だけに保持されます。";
    console.error("[DopaCopa] Session workspace unavailable; history is not persistent.");
}
initialized = true;
for (const event of startupEvents.splice(0)) receive(event);
scheduleSave();

process.once("SIGTERM", async () => {
    if (saveTimer) clearTimeout(saveTimer);
    await saveWork;
    if (storagePath) {
        try {
            await writeFile(`${storagePath}.tmp`, JSON.stringify(monitor.snapshot()), { mode: 0o600 });
            await rename(`${storagePath}.tmp`, storagePath);
        } catch (error) {
            console.error("[DopaCopa] Final snapshot failed:", error);
        }
    }
    await Promise.all([...servers.values()].map(async (pending) => (await pending).close()));
    process.exit(0);
});
