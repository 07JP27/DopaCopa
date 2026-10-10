import test from "node:test";
import assert from "node:assert/strict";
import { Presentation, SoundEngine, TokenCountUp, sceneForEvent, projectionForView } from "./stage.mjs";
import { EventMonitor } from "./events.mjs";

let id = 0;
const event = (type, data = {}) => ({
    id: `test-${++id}`, type, data, timestamp: new Date().toISOString(),
});

function monitorAndStage() {
    const monitor = new EventMonitor();
    const stage = new Presentation();
    stage.accept(monitor.view(), { now: 0 });
    return { monitor, stage };
}

test("token totals count upward through intermediate integers and reach the exact total", () => {
    const counter = new TokenCountUp();
    counter.set(1000, 0);
    assert.equal(counter.valueAt(0), 1000);
    counter.set(2000, 100);
    assert.equal(counter.valueAt(100), 1000);
    const halfway = counter.valueAt(425);
    assert.ok(halfway > 1000 && halfway < 2000);
    assert.equal(counter.valueAt(750), 2000);
});

test("new token usage retargets from the visible value without going backward", () => {
    const counter = new TokenCountUp();
    counter.set(1000, 0);
    counter.set(2000, 100);
    const shown = counter.valueAt(300);
    counter.set(3000, 300);
    assert.equal(counter.valueAt(300), shown);
    let last = shown;
    for (let now = 320; now <= 1000; now += 20) {
        const value = counter.valueAt(now);
        assert.ok(value >= last && value <= 3000);
        last = value;
    }
    assert.equal(last, 3000);
});

test("unchanged snapshots do not restart the token count-up", () => {
    const counter = new TokenCountUp();
    counter.set(1000, 0);
    counter.set(2000, 100);
    for (let now = 150; now < 750; now += 50) counter.set(2000, now);
    assert.equal(counter.valueAt(750), 2000);
});

test("initial, restored and reduced-motion totals update immediately and handle zero", () => {
    const counter = new TokenCountUp();
    assert.equal(counter.valueAt(0), null);
    counter.set(30_000_000, 0);
    assert.equal(counter.valueAt(0), 30_000_000);
    counter.set(31_000_000, 100, true);
    assert.equal(counter.valueAt(100), 31_000_000);
    counter.set(0, 200);
    assert.equal(counter.valueAt(200), 0);
    counter.set(null, 300);
    assert.equal(counter.valueAt(300), null);
    assert.throws(() => counter.set(-1, 400), RangeError);
});

test("opening a running session needs no start operation and does not replay an impact", () => {
    const monitor = new EventMonitor();
    monitor.receive(event("tool.execution_start", {
        toolName: "view", toolCallId: "running-read", arguments: { path: "Actual.cs" },
    }));
    const stage = new Presentation();
    stage.accept(monitor.view(), { now: 100 });
    assert.equal(stage.step(100).scene.word, "読込");
    assert.equal(stage.step(100).scene.files[0].path, "Actual.cs");
    assert.equal(stage.step(100).phase, "sustain");
    assert.equal(stage.launch, undefined);
});

test("an activity enters with anticipation and persists only while actually running", () => {
    const { monitor, stage } = monitorAndStage();
    monitor.receive(event("tool.execution_start", {
        toolName: "view", toolCallId: "read", arguments: { path: "/project/重要なファイル.ts" },
    }));
    stage.accept(monitor.view(), { now: 1000 });
    assert.equal(stage.step(1000).phase, "windup");
    assert.equal(stage.step(1210).phase, "strike");
    assert.equal(stage.step(1450).phase, "burst");
    assert.equal(stage.step(2500).phase, "sustain");
    assert.equal(stage.step(2500).scene.files[0].path, "/project/重要なファイル.ts");
    monitor.receive(event("tool.execution_complete", { toolCallId: "read", success: true }));
    stage.accept(monitor.view(), { now: 3000 });
    assert.equal(stage.step(3000).phase, "release");
    assert.equal(stage.step(3500).scene.word, "");
    assert.equal(stage.step(3500).phase, "idle");
});

test("tools that start and finish in one snapshot show a short afterimage, never a running loop", () => {
    const { monitor, stage } = monitorAndStage();
    monitor.receive(event("tool.execution_start", { toolName: "view", toolCallId: "read", arguments: { path: "a.ts" } }));
    monitor.receive(event("tool.execution_complete", { toolCallId: "read", success: true }));
    stage.accept(monitor.view(), { now: 20 });
    assert.equal(stage.live.length, 0);
    assert.equal(stage.step(20).phase, "strike");
    assert.equal(stage.step(20).scene.files[0].path, "a.ts");
    assert.equal(stage.step(1300).scene.word, "");
    assert.equal(stage.current, null);
});

test("ending one concurrent activity keeps the other actual file operation visible", () => {
    const { monitor, stage } = monitorAndStage();
    for (const file of ["a.ts", "b.ts"]) {
        monitor.receive(event("tool.execution_start", { toolName: "view", toolCallId: file, arguments: { path: file } }));
    }
    stage.accept(monitor.view(), { now: 10 });
    assert.deepEqual(stage.step(10).scene.files.map((file) => file.path), ["a.ts", "b.ts"]);
    monitor.receive(event("tool.execution_complete", { toolCallId: "b.ts", success: true }));
    stage.accept(monitor.view(), { now: 20 });
    assert.equal(stage.live.length, 1);
    assert.deepEqual(stage.step(20).scene.files.map((file) => file.path), ["a.ts"]);
});

test("completion, idle and cancelled work do not create a complete or waiting scene", () => {
    for (const source of [
        { kind: "done", phase: "idle", type: "session.idle" },
        { kind: "done", phase: "cancelled", type: "abort" },
        { kind: "done", phase: "success", type: "session.task_complete", meta: { success: true } },
        { kind: "done", phase: "success", type: "subagent.completed" },
    ]) {
        const scene = sceneForEvent(source);
        assert.equal(scene.word, "");
        assert.equal(scene.badge, undefined);
    }
});

test("high event volume has no unbounded cinematic queue or stale completed-file replay", () => {
    const { monitor, stage } = monitorAndStage();
    for (let i = 0; i < 150; i++) {
        monitor.receive(event("tool.execution_start", {
            toolName: "view", toolCallId: `read-${i}`, arguments: { path: `file-${i}.ts` },
        }));
    }
    stage.accept(monitor.view(), { now: 100 });
    assert.equal(stage.step(100).scene.files.length, 150);
    for (let i = 0; i < 150; i++) monitor.receive(event("tool.execution_complete", {
        toolCallId: `read-${i}`, success: true,
    }));
    stage.accept(monitor.view(), { now: 200 });
    assert.equal(stage.live.length, 0);
    assert.equal(stage.pending, undefined);
    assert.equal(stage.step(1800).scene.word, "");
    assert.equal(stage.combo, 150);
});

test("reconnect does not replay historical completion or result audio phases", () => {
    const { monitor, stage } = monitorAndStage();
    monitor.receive(event("tool.execution_complete", {
        toolCallId: "write", success: true, fileEdits: [{ path: "changed.ts", kind: "edit" }],
    }));
    stage.accept(monitor.view(), { now: 10 });
    assert.equal(stage.step(10).phase, "strike");
    stage.accept(monitor.view(), { reset: true, now: 20 });
    assert.equal(stage.step(20).scene.word, "");
    stage.accept(monitor.view(), { now: 30 });
    assert.equal(stage.step(30).phase, "idle");
});

test("motion off tracks actual completion without freezing stale file activities", () => {
    const { monitor, stage } = monitorAndStage();
    stage.pause(true);
    monitor.receive(event("tool.execution_start", {
        toolName: "view", toolCallId: "read", arguments: { path: "LiveFile.cs" },
    }));
    stage.accept(monitor.view(), { now: 100 });
    assert.equal(stage.step(100).phase, "still");
    assert.equal(stage.step(100).scene.files[0].path, "LiveFile.cs");
    monitor.receive(event("tool.execution_complete", { toolCallId: "read", success: true }));
    stage.accept(monitor.view(), { now: 200 });
    assert.equal(stage.step(200).scene.word, "");
});

test("partial failure interrupts with the actually committed file, then disappears", () => {
    const { monitor, stage } = monitorAndStage();
    monitor.receive(event("tool.execution_complete", {
        toolCallId: "failed-edit", success: false, fileEdits: [{ kind: "edit", path: "partial.ts" }],
    }));
    stage.accept(monitor.view(), { now: 2 });
    assert.equal(stage.step(2).scene.word, "失敗");
    assert.equal(stage.step(2).scene.files[0].path, "partial.ts");
    assert.equal(stage.step(1700).scene.word, "");
});

test("lettering fits the panel while its surrounding effects can fill it", () => {
    const view = {
        scene: { kind: "read" }, phase: "strike", elapsed: 200, strike: 180, burst: 380, energy: 0.5,
    };
    for (const [w, h] of [[360, 740], [540, 950], [1280, 800]]) {
        const projection = projectionForView(view, w, h);
        assert.ok(projection.widthRatio > 0.85 && projection.widthRatio < 1);
        assert.ok(Math.abs(projection.angle) > 0.1);
        assert.ok(projection.x - w * projection.widthRatio / 2 > 0);
        assert.ok(projection.x + w * projection.widthRatio / 2 < w);
        assert.equal(projectionForView(view, w, h, false).widthRatio, 0.88);
    }
});

function fakeAudioContext() {
    const param = () => ({
        value: 0, calls: [],
        setValueAtTime(value, time) { this.value = value; this.calls.push({ kind: "set", value, time }); },
        linearRampToValueAtTime(value, time) { this.calls.push({ kind: "linear", value, time }); },
        exponentialRampToValueAtTime(value, time) { this.calls.push({ kind: "exponential", value, time }); },
        cancelScheduledValues() {},
    });
    return {
        state: "suspended", currentTime: 20, sampleRate: 100, destination: {}, sources: [], filters: [], signal: 0, decodes: 0,
        async resume() { this.state = "running"; },
        async suspend() { this.state = "suspended"; },
        addEventListener() {},
        async decodeAudioData(bytes) {
            this.decodes++;
            return { name: SoundEngine.files[new Uint8Array(bytes)[0]], duration: 1.5 };
        },
        createGain() { return { gain: param(), connect() {}, disconnect() {} }; },
        createDynamicsCompressor() {
            return { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect() {} };
        },
        createBiquadFilter() {
            const filter = { type: "", frequency: param(), Q: param(), connect() {}, disconnect() {} };
            this.filters.push(filter);
            return filter;
        },
        createBuffer(channels, length) {
            const samples = new Float32Array(length);
            return { getChannelData() { return samples; } };
        },
        createBufferSource() {
            const now = this.currentTime;
            const source = {
                connect() {}, disconnect() {},
                start(time = now) { this.startAt = time; }, stop(time) { this.stopAt = time; },
            };
            this.sources.push(source);
            return source;
        },
        createAnalyser() {
            const context = this;
            return { fftSize: 512, connect() {}, getFloatTimeDomainData(samples) { samples.fill(context.signal); } };
        },
        createOscillator() {
            const source = {
                frequency: param(), connect() {}, disconnect() {},
                start(time) { this.startAt = time; }, stop(time) { this.stopAt = time; },
            };
            this.sources.push(source);
            return source;
        },
    };
}

function sampleSound(context) {
    return new SoundEngine(() => context, () => {}, async (url) =>
        new Uint8Array([SoundEngine.files.indexOf(url.pathname.split("/").at(-1))]).buffer);
}

test("autoplay can remain pending without blocking startup; one speaker gesture enables sound", async () => {
    const context = fakeAudioContext();
    context.resume = () => new Promise(() => {});
    const sound = sampleSound(context);
    assert.equal(sound.autoEnable(), undefined);
    assert.equal(sound.state, "blocked");
    assert.equal(sound.audible, false);
    context.resume = async () => { context.state = "running"; };
    await sound.enable();
    sound.confirm();
    assert.equal(sound.state, "ready");
    assert.equal(sound.audible, true);
    assert.equal(sound.nodes.size, 1);
    assert.equal(context.sources[0].buffer.name, "chime.mp3");
});

test("allowed autoplay enables event sound without a start button", async () => {
    const sound = sampleSound(fakeAudioContext());
    sound.autoEnable();
    await sound.loading;
    await Promise.resolve();
    assert.equal(sound.audible, true);
    sound.cue({ kind: "write", major: true }, "windup");
    assert.equal(sound.nodes.size, 1);
});

test("confirmation sound does not depend on synchronous AudioParam value updates", async () => {
    const context = fakeAudioContext();
    const createGain = context.createGain.bind(context);
    context.createGain = () => {
        const gain = createGain();
        gain.gain.setValueAtTime = (value, time) => gain.gain.calls.push({ value, time });
        return gain;
    };
    const sound = sampleSound(context);
    await sound.enable();
    assert.equal(sound.output.gain.value, 0);
    sound.confirm();
    assert.equal(sound.nodes.size, 1);
});

test("muting during a pending enable cannot be undone by its later resolution", async () => {
    const context = fakeAudioContext();
    let resolve;
    context.resume = () => new Promise((done) => { resolve = done; });
    const sound = sampleSound(context);
    const pending = sound.enable();
    sound.mute();
    context.state = "running";
    resolve();
    await pending;
    assert.equal(sound.state, "muted");
    assert.equal(sound.output.gain.value, 0);
});

test("speaker mute stops supplied samples and measures real signal state", async () => {
    const context = fakeAudioContext();
    const sound = sampleSound(context);
    await sound.enable();
    sound.confirm();
    assert.equal(context.sources[0].buffer.name, "chime.mp3");
    context.signal = 0.03;
    assert.ok(sound.sample() > 0);
    assert.ok(sound.status().peak > 0);
    sound.mute();
    assert.equal(sound.nodes.size, 0);
    assert.ok(context.sources.every((source) => source.stopAt === context.currentTime));
    assert.equal(sound.output.gain.value, 0);
    assert.equal(sound.audible, false);
});

test("sound stays bounded and hidden-panel suspension has a distinct state", async () => {
    const sound = sampleSound(fakeAudioContext());
    await sound.enable();
    for (let i = 0; i < 100; i++) sound.cue({ kind: "write", major: true }, "windup");
    assert.equal(sound.nodes.size, 8);
    await sound.suspend();
    assert.equal(sound.state, "paused");
    assert.equal(sound.nodes.size, 0);
    await sound.resume();
    assert.equal(sound.state, "ready");
});

test("all supplied MP3s are cached once and no synthesized sources are used", async () => {
    const context = fakeAudioContext();
    const sound = sampleSound(context);
    await sound.enable();
    await sound.enable();
    assert.equal(context.decodes, 16);
    assert.equal(sound.buffers.size, 16);
    assert.equal(sound.tone, undefined);
    assert.equal(sound.noise, undefined);
});

test("all uploaded assets are reachable through event mappings and variants rotate", async () => {
    const used = new Set();
    for (const kind of ["read", "search", "write", "shell", "think", "reply", "compact", "agent"]) {
        const context = fakeAudioContext();
        const sound = sampleSound(context);
        await sound.enable();
        for (const phase of ["windup", "strike", "burst"]) {
            for (let i = 0; i < 3; i++) sound.cue({ kind }, phase);
        }
        for (const source of context.sources) used.add(source.buffer.name);
    }
    const context = fakeAudioContext();
    const sound = sampleSound(context);
    await sound.enable();
    sound.confirm();
    used.add(context.sources[0].buffer.name);
    assert.deepEqual([...used].sort(), [...SoundEngine.files].sort());
});

test("muting while assets load prevents delayed playback", async () => {
    const context = fakeAudioContext();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const sound = new SoundEngine(() => context, () => {}, async () => { await pending; return new Uint8Array([0]).buffer; });
    const enabling = sound.enable();
    sound.mute();
    release();
    await enabling;
    sound.confirm();
    assert.equal(sound.nodes.size, 0);
    assert.equal(sound.output.gain.value, 0);
});
