const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const easeOut = (value) => 1 - (1 - clamp(value)) ** 3;

export class TokenCountUp {
    constructor() {
        this.value = null;
        this.target = null;
        this.from = 0;
        this.started = 0;
    }

    set(total, now, instant = false) {
        if (total !== null && (!Number.isSafeInteger(total) || total < 0)) {
            throw new RangeError("Token total must be a non-negative safe integer.");
        }
        const current = this.valueAt(now);
        if (instant || total === null || current === null || total <= current || total < this.target) {
            this.value = total;
            this.target = total;
            this.from = total ?? 0;
            this.started = now;
        } else if (total !== this.target) {
            this.from = current;
            this.target = total;
            this.started = now;
        }
    }

    valueAt(now) {
        if (this.value === null || this.value === this.target) return this.value;
        const progress = clamp((now - this.started) / 650);
        this.value = progress === 1 ? this.target :
            Math.min(this.target, Math.floor(this.from + (this.target - this.from) * easeOut(progress)));
        return this.value;
    }
}

const words = {
    read: "読込", write: "書換", search: "探索", think: "推論", reply: "生成",
    shell: "実行", compact: "圧縮", agent: "参戦", permission: "確認", error: "失敗",
    done: "", system: "", idle: "",
};

function eventPhase(event) {
    if (event.phase) return event.phase;
    if (event.type === "session.idle") return "idle";
    if (event.type === "abort") return "cancelled";
    if (event.type.endsWith("_start") || event.type === "subagent.started") return "start";
    if (event.meta?.success === true) return "success";
    if (event.kind === "error") return "failure";
    return "notice";
}

function distinctFiles(files) {
    const seen = new Set();
    return files.filter((file) => {
        if (!file || typeof file.path !== "string" || !file.path || seen.has(file.path)) return false;
        seen.add(file.path);
        return true;
    });
}

export function sceneForEvent(event) {
    const phase = eventPhase(event);
    const kind = phase === "idle" || phase === "cancelled" ? "idle" : event.kind;
    const files = distinctFiles(event.meta?.files?.length ? event.meta.files : event.meta?.targets ?? []);
    let word = words[kind] ?? "";
    let priority = { read: 2, write: 3, search: 2, think: 1, reply: 1, shell: 2,
        compact: 4, agent: 3, permission: 4, error: 5, done: 0, system: 0, idle: 0 }[kind] ?? 0;
    if (event.type === "subagent.completed" || event.type === "session.task_complete" ||
        (kind === "permission" && phase !== "waiting")) {
        word = event.type === "session.task_complete" && phase === "failure" ? "失敗" : "";
        priority = word ? 5 : 0;
    }
    const major = ["write", "compact", "agent", "error"].includes(kind);
    const agent = event.agent || "main";
    const source = event.meta?.toolCallId || (kind === "compact" ? `compact:${agent}` :
        kind === "think" || kind === "reply" ? `model:${agent}` : agent);
    return {
        id: event.id, sequence: event.sequence, kind, word, priority, major,
        source, phase, files,
        title: event.meta?.agentName || event.meta?.executable || event.meta?.toolName || event.title,
        before: typeof event.meta?.before === "number" ? event.meta.before : undefined,
        after: typeof event.meta?.after === "number" ? event.meta.after : undefined,
        type: event.type,
        theme: kind === "read" || kind === "search" ? "ice" :
            kind === "think" || kind === "reply" || kind === "agent" ? "violet" :
            kind === "error" ? "red" : "gold",
    };
}

const idleScene = () => ({
    id: "idle", source: "idle", kind: "idle", word: "", priority: 0,
    theme: "gold", major: false, files: [], phase: "idle", title: "",
});

function liveScenes(snapshot) {
    return (snapshot.active ?? []).map((activity) => ({
        ...sceneForEvent({
            id: `${activity.id}@${activity.started}`, sequence: snapshot.sequence,
            kind: activity.kind, phase: activity.kind === "permission" ? "waiting" : "progress",
            type: "active", title: activity.title,
            meta: { targets: activity.targets ?? [], toolName: activity.title, executable: activity.executable,
                before: activity.kind === "compact" ? snapshot.currentTokens : undefined },
        }),
        source: activity.id, observedAt: Date.parse(activity.started) || 0,
    })).filter((scene) => scene.priority > 0);
}

export class Presentation {
    constructor() {
        this.sequence = null;
        this.current = null;
        this.live = [];
        this.afterimage = null;
        this.combo = 0;
        this.energy = 0;
        this.lastStep = null;
        this.paused = false;
    }

    accept(snapshot, { reset = false, now = 0 } = {}) {
        const previous = this.current;
        this.live = liveScenes(snapshot);
        const best = this.live.toSorted((a, b) => b.priority - a.priority || b.observedAt - a.observedAt)[0];
        if (reset || this.sequence === null || snapshot.sequence < this.sequence) {
            this.sequence = snapshot.sequence;
            this.current = best ? { scene: best, started: now, cold: true } : null;
            this.afterimage = null;
            this.energy = 0;
            return;
        }
        let finished;
        let interrupted;
        for (const event of snapshot.events ?? []) {
            if (event.sequence <= this.sequence) continue;
            if (event.type === "user.message") this.combo = 0;
            if (event.type === "tool.execution_start") this.combo++;
            if (event.stream) this.energy = clamp(this.energy + Math.min(event.count ?? 1, 10) * 0.035);
            if (!event.impact) continue;
            const scene = sceneForEvent(event);
            if (scene.kind === "error" && scene.word) interrupted = scene;
            else if (scene.word && ["success", "finished"].includes(scene.phase)) finished = scene;
            else if (!scene.priority) {
                this.energy = clamp(this.energy + 0.12);
            }
        }
        this.sequence = snapshot.sequence;
        if (best) {
            this.current = previous?.scene.id === best.id ? { ...previous, scene: best } :
                { scene: best, started: now, cold: this.paused };
            this.afterimage = null;
        } else {
            this.current = null;
            if (previous && !this.paused) {
                const scene = finished?.source === previous.scene.source ?
                    { ...previous.scene, files: finished.files.length ? finished.files : previous.scene.files } : previous.scene;
                this.afterimage = { scene, started: now, duration: 420, instant: false };
            } else if (finished?.word && finished.priority >= 2 && !this.paused) {
                // A tool can start and finish within one SSE snapshot; show only a short result impact.
                this.afterimage = { scene: finished, started: now, duration: 1100, instant: true };
            }
        }
        if (interrupted && !this.paused) {
            this.afterimage = { scene: interrupted, started: now, duration: 1600, instant: true };
        }
    }

    pause(value) {
        this.paused = value;
        this.afterimage = null;
        if (this.current) this.current.cold = true;
        this.energy = 0;
    }

    step(now) {
        const delta = this.lastStep === null ? 0 : Math.min(1, Math.max(0, now - this.lastStep) / 1000);
        this.lastStep = now;
        this.energy = Math.max(0, this.energy - delta * 0.18);
        if (this.paused) {
            return { scene: this.current?.scene ?? idleScene(), phase: "still",
                elapsed: 0, energy: 0, combo: this.combo, opacity: 1 };
        }
        if (this.afterimage && now - this.afterimage.started >= this.afterimage.duration) this.afterimage = null;
        if (this.afterimage) {
            const elapsed = now - this.afterimage.started;
            const instant = this.afterimage.instant;
            return {
                scene: this.afterimage.scene, phase: instant && elapsed < 180 ? "strike" :
                    instant && elapsed < 450 ? "burst" : "release",
                elapsed, strike: 0, burst: 180, release: instant ? 450 : 0,
                opacity: instant && elapsed < 450 ? 1 :
                    1 - clamp((elapsed - (instant ? 450 : 0)) / (this.afterimage.duration - (instant ? 450 : 0))),
                energy: this.energy, combo: this.combo, afterimage: true,
            };
        }
        if (!this.current) {
            return { scene: idleScene(), phase: "idle", elapsed: now, energy: this.energy,
                combo: this.combo, opacity: 1 };
        }
        const elapsed = now - this.current.started;
        const major = this.current.scene.major;
        const strike = major ? 350 : 180;
        const burst = major ? 580 : 380;
        const phase = this.current.cold ? "sustain" : elapsed < strike ? "windup" :
            elapsed < burst ? "strike" : elapsed < (major ? 1300 : 1050) ? "burst" : "sustain";
        const scene = { ...this.current.scene, files: distinctFiles(this.live.filter((item) =>
            item.kind === this.current.scene.kind).flatMap((item) => item.files)) };
        return { scene, phase, elapsed, strike, burst, opacity: 1, energy: this.energy, combo: this.combo };
    }
}

export class SoundEngine {
    static files = Object.freeze([
        "insight.mp3", "chime.mp3", "dash.mp3", "item-2.mp3", "item-1.mp3",
        "spotlight.mp3", "boom.mp3", "clang.mp3", "transition.mp3",
        "sparkle-2.mp3", "sparkle-1.mp3", "explosion-2.mp3", "explosion-1.mp3",
        "shakiin-3.mp3", "shakiin-2.mp3", "shakiin-1.mp3",
    ]);

    constructor(contextFactory, onChange = () => {}, assetLoader = async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`音源の読み込みに失敗: ${url.pathname} (HTTP ${response.status})`);
        return response.arrayBuffer();
    }) {
        this.contextFactory = contextFactory ?? (() => {
            const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
            if (!AudioContext) throw new Error("Web Audioを利用できません");
            return new AudioContext();
        });
        this.context = null;
        this.output = null;
        this.nodes = new Set();
        this.muted = true;
        this.buffers = new Map();
        this.gains = new Map();
        this.variants = new Map();
        this.assetLoader = assetLoader;
        this.loading = null;
        this.onChange = onChange;
        this.suppressed = false;
        this.error = null;
        this.peak = 0;
        this.signalReported = false;
    }

    get state() {
        if (this.muted) return "muted";
        if (this.error) return "error";
        if (this.suppressed) return "paused";
        if (this.buffers.size !== SoundEngine.files.length) return "blocked";
        return this.context?.state === "running" ? "ready" : "blocked";
    }

    get audible() {
        return this.state === "ready";
    }

    status() {
        return {
            state: this.state, contextState: this.context?.state ?? "uninitialized",
            gain: this.output?.gain.value ?? 0, peak: this.peak, voices: this.nodes.size,
            error: this.error?.message ?? "",
        };
    }

    notify() {
        this.onChange(this.status());
    }

    prepare() {
        if (!this.context) {
            this.context = this.contextFactory();
            this.output = this.context.createGain();
            this.output.gain.value = 0;
            const compressor = this.context.createDynamicsCompressor();
            compressor.threshold.value = -12;
            compressor.knee.value = 4;
            compressor.ratio.value = 6;
            compressor.attack.value = 0.001;
            compressor.release.value = 0.085;
            this.analyser = this.context.createAnalyser();
            this.analyser.fftSize = 512;
            this.samples = new Float32Array(this.analyser.fftSize);
            this.output.connect(compressor);
            compressor.connect(this.analyser);
            this.analyser.connect(this.context.destination);
            this.context.addEventListener("statechange", () => {
                this.syncVolume();
                this.notify();
            });
        }
    }

    loadAssets() {
        if (!this.loading) {
            this.loading = Promise.all(SoundEngine.files.map(async (name) => {
                const url = new URL(`./sounds/${name}`, import.meta.url);
                url.search = new URL(import.meta.url).search;
                const bytes = await this.assetLoader(url);
                const buffer = await this.context.decodeAudioData(bytes.slice(0));
                this.buffers.set(name, buffer);
            })).then(() => this.notify()).catch((error) => {
                this.loading = null;
                throw error;
            });
        }
        return this.loading;
    }

    syncVolume() {
        if (!this.context) return;
        this.output.gain.setValueAtTime(
            !this.muted && !this.suppressed && this.context.state === "running" ? 0.35 : 0,
            this.context.currentTime);
    }

    autoEnable() {
        this.muted = false;
        this.error = null;
        try {
            this.prepare();
            // Autoplay can leave resume() pending until a user gesture; never await it during startup.
            Promise.all([this.context.resume(), this.loadAssets()]).then(() => {
                this.syncVolume();
                this.notify();
            }).catch((error) => {
                this.error = error;
                console.error("[DopaCopa] Audio assets or activation failed:", error);
                this.notify();
            });
            this.syncVolume();
        } catch (error) {
            this.error = error;
        }
        this.notify();
    }

    async enable() {
        this.muted = false;
        this.suppressed = false;
        this.error = null;
        this.signalReported = false;
        this.prepare();
        this.notify();
        await Promise.all([this.context.resume(), this.loadAssets()]);
        if (this.context.state !== "running") throw new Error("音の再生が許可されていません");
        this.syncVolume();
        this.notify();
        return !this.muted;
    }

    sample() {
        if (!this.analyser) return 0;
        this.analyser.getFloatTimeDomainData(this.samples);
        const rms = Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
        this.peak = Math.max(this.peak, rms);
        if (rms > 0.00001 && !this.signalReported) {
            this.signalReported = true;
            this.notify();
        }
        return rms;
    }

    confirm() {
        this.play("chime.mp3");
    }

    silence() {
        if (!this.context) return;
        this.output.gain.cancelScheduledValues(this.context.currentTime);
        this.output.gain.setValueAtTime(0, this.context.currentTime);
        for (const source of this.nodes) {
            source.stop(this.context.currentTime);
        }
        this.nodes.clear();
        this.gains.clear();
    }

    mute() {
        this.muted = true;
        this.silence();
        this.notify();
    }

    async suspend() {
        this.suppressed = true;
        this.silence();
        if (this.context?.state === "running") await this.context.suspend();
        this.notify();
    }

    async resume() {
        if (!this.context || this.muted) return;
        this.suppressed = false;
        await this.context.resume();
        if (this.context.state !== "running") throw new Error("音の再生を再開できません");
        this.syncVolume();
        this.notify();
    }

    play(name) {
        if (!this.audible) return;
        const buffer = this.buffers.get(name);
        if (!buffer) throw new Error(`未登録の音源: ${name}`);
        if (this.nodes.size >= 8) {
            const oldest = this.nodes.values().next().value;
            const gain = this.gains.get(oldest);
            gain.gain.cancelScheduledValues(this.context.currentTime);
            gain.gain.setValueAtTime(gain.gain.value, this.context.currentTime);
            gain.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.006);
            oldest.stop(this.context.currentTime + 0.006);
            this.nodes.delete(oldest);
            this.gains.delete(oldest);
        }
        const source = this.context.createBufferSource();
        const gain = this.context.createGain();
        gain.gain.value = 1;
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(this.output);
        this.nodes.add(source);
        this.gains.set(source, gain);
        source.onended = () => {
            this.nodes.delete(source);
            this.gains.delete(source);
            source.disconnect();
            gain.disconnect();
        };
        source.start();
    }

    cue(scene, phase) {
        if (!this.audible) return;
        const choices = {
            windup: {
                think: ["insight.mp3"], reply: ["transition.mp3"], read: ["dash.mp3"],
                search: ["transition.mp3", "dash.mp3"],
                write: ["shakiin-1.mp3", "shakiin-2.mp3", "shakiin-3.mp3"],
                shell: ["dash.mp3"], compact: ["transition.mp3"], agent: ["spotlight.mp3"],
                permission: ["chime.mp3"],
            },
            strike: {
                read: ["shakiin-1.mp3", "shakiin-2.mp3", "shakiin-3.mp3"],
                search: ["clang.mp3"], write: ["clang.mp3", "boom.mp3"],
                shell: ["explosion-1.mp3", "explosion-2.mp3"], compact: ["boom.mp3"],
                agent: ["shakiin-3.mp3"], error: ["boom.mp3"],
            },
            burst: {
                read: ["sparkle-1.mp3", "sparkle-2.mp3"], search: ["item-1.mp3", "item-2.mp3"],
                write: ["explosion-1.mp3", "explosion-2.mp3"], shell: ["shakiin-2.mp3", "shakiin-3.mp3"],
                compact: ["item-1.mp3", "item-2.mp3"], agent: ["sparkle-1.mp3", "sparkle-2.mp3"],
                reply: ["item-1.mp3", "item-2.mp3"], think: ["sparkle-1.mp3", "sparkle-2.mp3"],
            },
        }[phase]?.[scene.kind];
        if (!choices) return;
        const key = `${scene.kind}:${phase}`;
        const index = this.variants.get(key) ?? 0;
        this.variants.set(key, index + 1);
        this.play(choices[index % choices.length]);
    }
}

const paletteNames = [
    "ink", "black", "red", "red-hot", "red-dark", "orange", "gold", "gold-light",
    "gold-dark", "gold-edge", "ivory", "cyan", "blue", "violet", "pink", "green", "clear",
];

function seeded(seed) {
    let value = (Number(seed) || 7) >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

export function projectionForView(view, width, height, motion = true) {
    const phase = view.phase;
    const elapsed = view.elapsed ?? 0;
    let widthRatio = 0.88 + (view.energy ?? 0) * 0.025;
    let offset = 0;
    let angle = -0.14;
    if (!motion || phase === "still") {
        widthRatio = 0.88;
        angle = -0.06;
    } else if (phase === "windup") {
        const progress = clamp(elapsed / Math.max(1, view.strike));
        widthRatio = 0.52 + progress * 0.33;
        offset = (1 - easeOut(progress)) * width * (view.scene.kind === "read" ? -0.17 : 0.17);
        angle = -0.32 + progress * 0.17;
    } else if (phase === "strike") {
        const progress = clamp((elapsed - view.strike) / Math.max(1, view.burst - view.strike));
        widthRatio = 0.96 - easeOut(progress) * 0.065;
        offset = Math.sin(elapsed * 0.045) * width * 0.008;
        angle = -0.13 + progress * 0.045;
    } else if (phase === "burst") {
        widthRatio = 0.895 - clamp((elapsed - (view.burst ?? 0)) / 700) * 0.025;
        offset = Math.sin(elapsed * 0.009) * width * 0.007;
        angle = -0.09;
    } else if (phase === "release") {
        widthRatio = 0.88 - (1 - (view.opacity ?? 1)) * 0.25;
        offset = (1 - (view.opacity ?? 1)) * width * 0.08;
    } else {
        offset = Math.sin(elapsed * 0.0006) * width * 0.006;
        angle = -0.07 + Math.sin(elapsed * 0.0005) * 0.015;
    }
    return { widthRatio, x: width * 0.5 + offset, y: height * 0.39, angle };
}

export class SceneCanvas {
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext("2d", { alpha: false });
        if (!this.context) throw new Error("Canvas 2Dを利用できません");
        const style = getComputedStyle(document.documentElement);
        this.palette = Object.fromEntries(paletteNames.map((name) =>
            [name, style.getPropertyValue(`--cp-stage-${name}`).trim()]));
        this.width = 0;
        this.height = 0;
        this.words = new Map();
        this.rays = [];
        this.particles = [];
        const random = seeded(27);
        for (let i = 0; i < 72; i++) {
            this.rays.push({ angle: i / 72 * Math.PI * 2, width: 0.012 + random() * 0.07,
                length: 0.2 + random() * 0.7, speed: 0.8 + random(), bright: random() });
        }
        for (let i = 0; i < 112; i++) {
            this.particles.push({ angle: random() * Math.PI * 2, radius: random(),
                speed: 0.4 + random() * 0.8, size: 1 + random() * 5, turn: random() * 6 });
        }
    }

    resize(width, height, dpr = globalThis.devicePixelRatio || 1) {
        this.width = width;
        this.height = height;
        this.dpr = Math.min(2, dpr);
        this.canvas.width = Math.round(width * this.dpr);
        this.canvas.height = Math.round(height * this.dpr);
        this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.words.clear();
    }

    metalWord(word, theme) {
        const key = `${word}:${theme}`;
        if (this.words.has(key)) return this.words.get(key);
        const p = this.palette;
        const fontSize = 220;
        const bitmap = document.createElement("canvas");
        bitmap.width = Math.max(700, word.length * 260 + 150);
        bitmap.height = 400;
        const c = bitmap.getContext("2d");
        c.font = `900 ${fontSize}px "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.lineJoin = "round";
        const x = bitmap.width / 2 - 14;
        const y = 172;
        const depth = c.createLinearGradient(0, 130, 0, 310);
        for (const [stop, color] of [[0, p["gold-light"]], [.22, p["gold-dark"]], [.5, p.gold],
            [.7, p["gold-edge"]], [.9, p["gold-light"]], [1, p["gold-dark"]]]) depth.addColorStop(stop, color);
        c.lineWidth = 24;
        c.strokeStyle = p.black;
        c.shadowColor = p.black;
        c.shadowBlur = 5;
        c.shadowOffsetX = 4;
        c.shadowOffsetY = 7;
        c.strokeText(word, x + 21, y + 30);
        c.shadowBlur = 0;
        c.shadowOffsetX = 0;
        c.shadowOffsetY = 0;
        c.lineWidth = 14;
        for (let i = 30; i >= 0; i--) {
            c.fillStyle = i % 6 < 3 ? depth : p["gold-dark"];
            c.strokeStyle = c.fillStyle;
            c.fillText(word, x + i * 0.7, y + i);
            c.strokeText(word, x + i * 0.7, y + i);
        }
        for (const [width, color] of [[26, p.black], [21, p["gold-light"]], [15, p["gold-edge"]],
            [11, p.gold], [6, p.ivory], [2, p["gold-dark"]]]) {
            c.lineWidth = width;
            c.strokeStyle = color;
            c.strokeText(word, x, y);
        }
        const face = c.createLinearGradient(0, 62, 0, 292);
        const stops = theme === "ice" ?
            [[0, p.ivory], [.2, p.cyan], [.43, p.blue], [.46, p["gold-edge"]],
                [.5, p.cyan], [.73, p.ivory], [1, p.blue]] :
            theme === "violet" ?
                [[0, p.ivory], [.2, p.pink], [.43, p.violet], [.46, p["gold-edge"]],
                    [.5, p.pink], [.73, p.ivory], [1, p.violet]] :
                theme === "red" ?
                    [[0, p.ivory], [.2, p["red-hot"]], [.43, p["red-dark"]], [.46, p.black],
                        [.5, p["red-hot"]], [.75, p.orange], [1, p["red-dark"]]] :
                    [[0, p.ivory], [.2, p["gold-light"]], [.43, p.gold], [.46, p["gold-edge"]],
                        [.5, p["gold-dark"]], [.74, p.gold], [.87, p["gold-light"]], [1, p["gold-dark"]]];
        for (const [stop, color] of stops) face.addColorStop(stop, color);
        c.fillStyle = face;
        c.fillText(word, x, y);
        c.globalCompositeOperation = "source-atop";
        const sheen = c.createLinearGradient(0, 0, bitmap.width, bitmap.height);
        for (const [stop, color] of [[0, p.clear], [.18, p.clear], [.21, p.ivory], [.235, p.clear],
            [.51, p.clear], [.535, p["gold-light"]], [.55, p.ivory], [.575, p.clear], [1, p.clear]]) {
            sheen.addColorStop(stop, color);
        }
        c.globalAlpha = .75;
        c.fillStyle = sheen;
        c.fillRect(0, 0, bitmap.width, bitmap.height);
        const random = seeded(word.codePointAt(0));
        for (let i = 0; i < 90; i++) {
            c.globalAlpha = 0.16 + random() * 0.4;
            c.fillStyle = p.ivory;
            c.fillRect(random() * bitmap.width, 60 + random() * 230, 1 + random() * 3, 1);
        }
        c.globalCompositeOperation = "source-over";
        c.globalAlpha = 1;
        const result = { bitmap, textWidth: c.measureText(word).width + 70, offset: x };
        this.words.set(key, result);
        if (this.words.size > 16) this.words.delete(this.words.keys().next().value);
        return result;
    }

    draw(view, time, motion = true) {
        if (!this.width || !this.height) return;
        const c = this.context;
        const p = this.palette;
        const w = this.width;
        const h = this.height;
        const scene = view.scene;
        const t = motion ? time / 1000 : 0;
        const cx = w * 0.5;
        const playTop = this.playTop ?? h * 0.13;
        const playBottom = this.playBottom ?? h * 0.66;
        const cy = clamp(h * .39, playTop, playBottom);
        const radius = Math.hypot(w, h);
        const active = Boolean(scene.word);
        const charge = view.phase === "windup";
        const striking = view.phase === "strike";
        const exploding = view.phase === "burst";
        const major = scene.major;
        const progress = charge ? clamp(view.elapsed / view.strike) : 1;
        const burstAge = Math.max(0, view.elapsed - (view.strike || 0)) / 1000;
        const energy = active ? major && exploding ? 0.97 : 0.6 + view.energy * 0.35 : 0.08;
        const spectrum = [p.gold, p.cyan, p.pink, p.violet, p.green, p["red-hot"]];
        const accent = scene.theme === "ice" ? p.cyan : scene.theme === "violet" ? p.pink : p.gold;

        c.save();
        c.fillStyle = p.ink;
        c.fillRect(0, 0, w, h);
        const background = c.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.68);
        background.addColorStop(0, charge ? p["red-dark"] : major && exploding ? p.ivory : p["red-hot"]);
        background.addColorStop(0.12, major && exploding ? p["gold-light"] : active ? p.red : p["red-dark"]);
        background.addColorStop(0.3, major && exploding ? p.orange : p["red-dark"]);
        background.addColorStop(0.6, major && exploding ? p["red-hot"] : p["red-dark"]);
        background.addColorStop(1, p.ink);
        c.globalAlpha = charge ? 0.3 + progress * 0.4 : energy;
        c.fillStyle = background;
        c.fillRect(0, 0, w, h);
        c.globalAlpha = 1;

        for (const [index, ray] of this.rays.entries()) {
            const angle = ray.angle + Math.sin(t * 0.11) * 0.08;
            const wave = motion ? ((t * ray.speed + ray.length) % 1) : ray.length;
            const inner = charge ? (0.07 + (1 - progress) * 0.35) * radius :
                (active ? 0.04 + wave * 0.2 : 0.25 + wave * 0.2) * radius;
            const outer = radius * 1.1;
            const width = ray.width * (major && exploding ? 1.8 : 1);
            c.beginPath();
            c.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
            c.lineTo(cx + Math.cos(angle - width) * outer, cy + Math.sin(angle - width) * outer);
            c.lineTo(cx + Math.cos(angle + width) * outer, cy + Math.sin(angle + width) * outer);
            c.closePath();
            const gradient = c.createLinearGradient(cx, cy, cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
            gradient.addColorStop(0, p["gold-light"]);
            gradient.addColorStop(0.3, major ? spectrum[index % spectrum.length] : ray.bright > 0.6 ? accent : p["red-hot"]);
            gradient.addColorStop(1, p.clear);
            c.fillStyle = gradient;
            c.globalAlpha = energy * (ray.bright > 0.65 ? major && exploding ? 0.75 : 0.5 : 0.18) * (charge ? progress : 1);
            c.fill();
            if (active && index % 3 === 0) {
                c.beginPath();
                c.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
                c.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
                c.lineWidth = ray.bright > 0.8 ? 2.5 : 0.8;
                c.strokeStyle = ray.bright > 0.8 ? p.ivory : p.gold;
                c.globalAlpha = 0.16 + ray.bright * 0.34;
                c.stroke();
            }
        }
        c.globalAlpha = 1;

        if (active) {
            const halo = c.createRadialGradient(cx, cy, w * 0.02, cx, cy, w * 0.53);
            halo.addColorStop(0, p["gold-light"]);
            halo.addColorStop(.25, major ? p.orange : scene.theme === "ice" ? p.blue : p["red-hot"]);
            halo.addColorStop(1, p.clear);
            c.globalAlpha = charge ? progress * 0.35 : major && exploding ? 0.72 : 0.25;
            c.fillStyle = halo;
            c.fillRect(0, 0, w, h);
            c.globalAlpha = 1;
            this.mechanism(scene, view, t, cx, cy);
            this.lightning(scene, t, cx, cy, energy);
            if (scene.kind === "read" || scene.kind === "search") this.slashes(view, t, cx, cy);
            if (striking || exploding) {
                const ring = (0.12 + burstAge * 0.6) * radius;
                c.strokeStyle = p["gold-light"];
                c.lineWidth = Math.max(1, 8 - burstAge * 4);
                c.globalAlpha = clamp(0.65 - burstAge * 0.4);
                c.beginPath();
                c.ellipse(cx, cy, ring, ring * 0.64, -0.2, 0, Math.PI * 2);
                c.stroke();
                c.globalAlpha = 1;
            }
        }

        const particleCount = active ? major ? 112 : 72 : 24;
        for (let i = 0; i < particleCount; i++) {
            const particle = this.particles[i];
            let distance;
            if (charge || (scene.kind === "compact" && scene.phase !== "success")) {
                distance = radius * (1 - ((t * 0.42 * particle.speed + particle.radius) % 1)) * 0.55;
            } else if (striking || exploding) {
                distance = radius * clamp(burstAge * particle.speed * 0.7);
            } else {
                distance = radius * (particle.radius + t * particle.speed * 0.07) % (radius * 0.65);
            }
            const angle = particle.angle + (scene.kind === "compact" ? t * 0.75 : Math.sin(t + particle.turn) * 0.03);
            const x = cx + Math.cos(angle) * distance;
            const y = cy + Math.sin(angle) * distance * 0.85;
            const size = particle.size * (major && active ? 1.6 : 0.7);
            c.save();
            c.translate(x, y);
            c.rotate(t * particle.speed + particle.turn);
            c.globalAlpha = active ? 0.35 + particle.radius * 0.5 : 0.15;
            c.fillStyle = i % 4 === 0 ? p.ivory : major && i % 5 === 0 ? spectrum[i % spectrum.length] : p.gold;
            c.beginPath();
            c.moveTo(0, -size * 1.8);
            c.lineTo(size * 0.55, 0);
            c.lineTo(0, size * 1.8);
            c.lineTo(-size * 0.55, 0);
            c.closePath();
            c.fill();
            if (i % 4 === 0 && active) {
                c.globalAlpha *= 0.5;
                c.fillRect(-size * 2.4, -0.5, size * 4.8, 1);
                c.fillRect(-0.5, -size * 2.4, 1, size * 4.8);
            }
            c.restore();
        }

        if (active) {
            const metal = this.metalWord(scene.word, scene.theme);
            const projection = projectionForView(view, w, h, motion);
            const requestedHorizontal = w * projection.widthRatio / metal.textWidth;
            const requestedVertical = Math.min(requestedHorizontal * 1.32, h * .42 / 250);
            const projectedHeight = 300 * requestedVertical * Math.cos(projection.angle) +
                w * projection.widthRatio * Math.abs(Math.sin(projection.angle));
            const fit = Math.min(1, Math.max(64, playBottom - playTop) / projectedHeight);
            const horizontal = requestedHorizontal * fit;
            const vertical = requestedVertical * fit;
            const halfHeight = projectedHeight * fit / 2;
            projection.y = clamp(projection.y, playTop + halfHeight, playBottom - halfHeight);
            c.save();
            c.translate(projection.x, projection.y);
            c.rotate(projection.angle);
            c.transform(1, 0, -0.1, 1, 0, 0);
            c.scale(horizontal, vertical);
            c.globalAlpha = (view.opacity ?? 1) * (charge ? 0.35 + progress * 0.65 : 1);
            c.shadowColor = accent;
            c.shadowBlur = striking || exploding ? 42 : 26;
            c.drawImage(metal.bitmap, -metal.offset, -172);
            c.restore();
            this.foreground(scene, view, t, cx, cy);
        }

        this.frame(t, active);
        c.restore();
    }

    foreground(scene, view, time, cx, cy) {
        const c = this.context;
        const p = this.palette;
        const w = this.width;
        const h = this.height;
        const peak = view.phase === "strike" || view.phase === "burst";
        const strength = (peak ? 1 : view.phase === "windup" ? 0.35 : 0.5) * (view.opacity ?? 1);
        const drift = Math.sin(time * 1.3);
        const accent = scene.theme === "ice" ? p.cyan : scene.theme === "violet" ? p.pink : p.gold;
        c.save();
        c.globalCompositeOperation = "lighter";
        for (let i = 0; i < (peak ? 7 : 4); i++) {
            c.save();
            c.translate(cx + Math.sin(time * 0.45 + i * 1.7) * w * 0.24,
                cy + Math.cos(i * 2.3 + time * 0.33) * h * 0.17);
            c.rotate((i % 2 ? 1 : -1) * (0.3 + i * 0.17));
            const light = c.createLinearGradient(0, -48, 0, 48);
            light.addColorStop(0, p.clear);
            light.addColorStop(.3, accent);
            light.addColorStop(.48, p.ivory);
            light.addColorStop(.52, p["gold-light"]);
            light.addColorStop(.7, accent);
            light.addColorStop(1, p.clear);
            c.fillStyle = light;
            c.globalAlpha = strength * (i < 3 ? 0.62 : 0.4);
            c.shadowColor = accent;
            c.shadowBlur = 24;
            const thickness = peak ? 18 + i * 5 : 8 + i * 3;
            c.fillRect(-w * 1.2, -thickness / 2, w * 2.4, thickness);
            c.restore();
        }
        this.lightning(scene, time * 1.25, cx, cy, strength);
        c.restore();

        for (const side of [-1, 1]) {
            c.save();
            c.translate(cx + side * w * (peak ? 0.48 : 0.52) + drift * w * 0.015,
                cy + side * h * 0.16);
            c.rotate(side * (peak ? 0.6 : 0.28));
            const metal = c.createLinearGradient(-w * 0.1, -h * 0.14, w * 0.1, h * 0.14);
            for (const [stop, color] of [[0, p["gold-edge"]], [.16, p["gold-light"]], [.35, p["gold-dark"]],
                [.5, p.ivory], [.57, p.gold], [.76, p["gold-dark"]], [1, p["gold-light"]]]) {
                metal.addColorStop(stop, color);
            }
            c.beginPath();
            c.moveTo(-w * 0.04, -h * 0.2);
            c.lineTo(w * 0.13, -h * 0.16);
            c.lineTo(w * 0.03, h * 0.1);
            c.lineTo(-w * 0.12, h * 0.19);
            c.closePath();
            c.globalAlpha = strength;
            c.fillStyle = metal;
            c.lineWidth = 5;
            c.strokeStyle = p["gold-edge"];
            c.fill();
            c.stroke();
            c.lineWidth = 1.5;
            c.strokeStyle = p["gold-light"];
            c.stroke();
            c.restore();
        }
        for (let i = 0; i < (peak ? 34 : 12); i++) {
            const particle = this.particles[i];
            const orbit = (particle.radius + time * particle.speed * 0.09) % 1;
            const x = cx + Math.cos(particle.angle) * orbit * w * 0.64;
            const y = cy + Math.sin(particle.angle) * orbit * h * 0.42;
            c.save();
            c.translate(x, y);
            c.rotate(time * particle.speed);
            c.globalAlpha = strength * 0.85;
            const size = particle.size * (peak ? 6 : 3);
            c.fillStyle = i % 3 ? p["gold-light"] : accent;
            c.shadowBlur = 12;
            c.shadowColor = c.fillStyle;
            c.beginPath();
            c.moveTo(-size, -size * 0.3);
            c.lineTo(size * 0.6, -size);
            c.lineTo(size, size * 0.25);
            c.lineTo(-size * 0.3, size);
            c.closePath();
            c.fill();
            c.restore();
        }
    }

    lightning(scene, time, cx, cy, energy) {
        const c = this.context;
        const p = this.palette;
        const count = scene.major ? 7 : 3;
        for (let i = 0; i < count; i++) {
            const angle = i / count * Math.PI * 2 + 0.2;
            const length = Math.hypot(this.width, this.height) * 0.65;
            c.beginPath();
            for (let j = 0; j < 12; j++) {
                const distance = 0.12 * this.width + j / 11 * length;
                const twist = Math.sin(j * 4.7 + i * 13 + time * 1.2) * this.width * 0.035;
                const x = cx + Math.cos(angle) * distance + Math.sin(angle) * twist;
                const y = cy + Math.sin(angle) * distance + Math.cos(angle) * twist;
                if (j === 0) c.moveTo(x, y);
                else c.lineTo(x, y);
            }
            c.globalAlpha = energy * 0.65;
            c.strokeStyle = scene.theme === "ice" ? p.cyan : i % 2 ? p.pink : p.gold;
            c.lineWidth = 4;
            c.shadowColor = c.strokeStyle;
            c.shadowBlur = 12;
            c.stroke();
            c.lineWidth = 1.1;
            c.strokeStyle = p.ivory;
            c.stroke();
        }
        c.shadowBlur = 0;
        c.globalAlpha = 1;
    }

    mechanism(scene, view, time, cx, cy) {
        const c = this.context;
        const p = this.palette;
        const w = this.width;
        const r = w * 0.4;
        const spin = scene.kind === "compact" ? -time * 0.4 : scene.kind === "search" ? time * 0.3 : time * 0.06;
        c.save();
        c.translate(cx, cy);
        c.rotate(spin);
        c.globalAlpha = view.phase === "windup" ? 0.7 : 0.34;
        for (let ring = 0; ring < 3; ring++) {
            c.lineWidth = ring === 0 ? 9 : 2;
            c.strokeStyle = ring % 2 ? p["gold-light"] : scene.theme === "ice" ? p.cyan : p.gold;
            for (let segment = 0; segment < 8; segment++) {
                const angle = segment * Math.PI / 4;
                c.beginPath();
                c.arc(0, 0, r * (1 + ring * 0.17), angle, angle + 0.52);
                c.stroke();
            }
        }
        c.restore();
        const closure = view.phase === "windup" ? easeOut(view.elapsed / view.strike) : 1;
        for (const side of [-1, 1]) {
            c.save();
            c.translate(cx + side * (w * 0.55 - closure * w * 0.21), cy + this.height * 0.015);
            c.rotate(side * -0.16);
            c.scale(side, 1);
            const metal = c.createLinearGradient(-30, -110, 50, 120);
            for (const [stop, color] of [[0, p["gold-edge"]], [.2, p["gold-light"]],
                [.43, p["gold-dark"]], [.5, p.ivory], [.57, p.gold], [1, p["gold-edge"]]]) metal.addColorStop(stop, color);
            c.beginPath();
            c.moveTo(-w * 0.04, -w * 0.24);
            c.lineTo(w * 0.065, -w * 0.2);
            c.lineTo(w * 0.02, -w * 0.08);
            c.lineTo(w * 0.1, 0);
            c.lineTo(w * 0.025, w * 0.08);
            c.lineTo(w * 0.065, w * 0.2);
            c.lineTo(-w * 0.04, w * 0.24);
            c.closePath();
            c.lineWidth = 6;
            c.strokeStyle = p.black;
            c.fillStyle = metal;
            c.stroke();
            c.fill();
            c.lineWidth = 1.5;
            c.strokeStyle = p["gold-light"];
            c.stroke();
            c.beginPath();
            c.moveTo(0, -w * 0.17);
            c.lineTo(w * 0.026, -w * 0.11);
            c.lineTo(-w * 0.003, 0);
            c.lineTo(w * 0.026, w * 0.11);
            c.lineTo(0, w * 0.17);
            c.strokeStyle = scene.theme === "ice" ? p.cyan : p["red-hot"];
            c.lineWidth = 4;
            c.shadowColor = c.strokeStyle;
            c.shadowBlur = 12;
            c.stroke();
            c.restore();
        }
    }

    slashes(view, time, cx, cy) {
        const c = this.context;
        const p = this.palette;
        const strength = view.phase === "strike" || view.phase === "burst" ? 0.85 : 0.22;
        for (const side of [-1, 1]) {
            c.save();
            c.translate(cx, cy);
            c.rotate(side * 0.5 + Math.sin(time * 0.3) * 0.04);
            c.globalAlpha = strength;
            const gradient = c.createLinearGradient(-this.width, 0, this.width, 0);
            gradient.addColorStop(0, p.clear);
            gradient.addColorStop(.4, p.cyan);
            gradient.addColorStop(.5, p.ivory);
            gradient.addColorStop(.6, p.cyan);
            gradient.addColorStop(1, p.clear);
            c.fillStyle = gradient;
            c.shadowBlur = 18;
            c.shadowColor = p.cyan;
            c.fillRect(-this.width, -4, this.width * 2, 8);
            c.restore();
        }
    }

    frame(time, active) {
        const c = this.context;
        const p = this.palette;
        const w = this.width;
        const h = this.height;
        const gradient = c.createLinearGradient(0, 0, w, h);
        for (const [stop, color] of [[0, p["gold-light"]], [.12, p["gold-edge"]], [.25, p.gold],
            [.45, p["gold-light"]], [.5, p["gold-dark"]], [.68, p.gold], [.9, p["gold-edge"]],
            [1, p["gold-light"]]]) gradient.addColorStop(stop, color);
        c.save();
        c.lineJoin = "miter";
        c.beginPath();
        c.moveTo(38, 9);
        c.lineTo(w - 38, 9);
        c.lineTo(w - 9, 39);
        c.lineTo(w - 9, h - 60);
        c.lineTo(w - 47, h - 9);
        c.lineTo(47, h - 9);
        c.lineTo(9, h - 60);
        c.lineTo(9, 39);
        c.closePath();
        c.lineWidth = 18;
        c.strokeStyle = p.black;
        c.stroke();
        c.lineWidth = 11;
        c.strokeStyle = gradient;
        c.stroke();
        c.lineWidth = 1;
        c.strokeStyle = p["gold-light"];
        c.stroke();
        for (let i = 0; i < 13; i++) {
            const y = 90 + i / 12 * (h - 200);
            for (const side of [0, 1]) {
                const x = side ? w - 18 : 18;
                c.beginPath();
                c.arc(x, y, 2.5, 0, Math.PI * 2);
                c.fillStyle = active && i % 3 === 0 ? p.ivory : p["red-hot"];
                c.shadowColor = c.fillStyle;
                c.shadowBlur = active ? 9 : 2;
                c.globalAlpha = active ? 0.55 + Math.sin(time * 2 + i) * 0.2 : 0.4;
                c.fill();
            }
        }
        c.restore();
    }
}
