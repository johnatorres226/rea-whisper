// Validates claims in docs/01-audio-capture.md. Exit code 1 on any failure.
import fs from "node:fs";
import vm from "node:vm";
const root = new URL("../", import.meta.url).pathname;
const P = (p) => root + p;
const hub = fs.readFileSync(P("work/pretty/renderer/hub/index.js"), "utf8").split("\n");
const main = fs.readFileSync(P("work/pretty/main/index.js"), "utf8").split("\n");
let fail = 0;
const ok = (name, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + extra)); if (!c) fail++; };
// line-anchored text check: expected substring must appear at (or within +-0) the cited line
const at = (arr, n, s) => (arr[n - 1] ?? "").includes(s);

// 1. constants / constraints
ok("tf=40 @hub:33991", at(hub, 33991, "tf = 40"));
ok("nf=16000 @hub:33992", at(hub, 33992, "nf = 16e3"));
ok("opus cfg bitrate 64e3 @hub:33997", at(hub, 33997, "bitrate: 64e3"));
ok("gUM constraints @hub:34129-34137", hub.slice(34128, 34137).join(" ").match(/echoCancellation: !1[\s\S]*noiseSuppression: !1[\s\S]*autoGainControl: !1[\s\S]*sampleRate: nf[\s\S]*channelCount: 1/) !== null);
ok("latencyHint interactive @hub:33890", at(hub, 33890, '$_ = "interactive"'));
ok("deviceId exact @hub:38141", hub.slice(38139, 38146).join(" ").includes("deviceId: { exact: mf.selectedDeviceId"));
ok("silence thresholds 125/375 @hub:34181-34182", at(hub, 34181, "= 125") && at(hub, 34182, "= 375"));
ok("worklet url @hub:34002", at(hub, 34002, "../dist/recorderWorklet.js"));
ok("volume = 20log10(rms+1e-10) @hub:7665-7666", at(hub, 7665, "Math.sqrt(e.reduce((e, t) => e + t * t, 0) / e.length)") && at(hub, 7666, "20 * Math.log10(t + 1e-10)"));
ok("IPC channel dictation:audioChunk @hub:3278", at(hub, 3278, '"dictation:audioChunk"'));
ok("status:audioLevel @main:145643", at(main, 145643, '"status:audioLevel"'));
ok("meter timer 150ms + mean @main:230479,230497", at(main, 230479, "Rn.reduce((e, t) => e + t, 0) / Rn.length") && at(main, 230497, "}, 150)"));
ok("meter floor E: default -60, span 20 @main-ref hub:156728-156741 (main bundle)", main.slice(156727, 156742).join(" ").match(/_ = -60,[\s\S]*t = 20[\s\S]*r < n && \(n = Math\.max\(e, r\)\)[\s\S]*\(r - n\) \/ t/) !== null);
ok("testing mode scaler (e+50)/40 @main:156742", at(main, 156742, "(e - -50) / 40"));
ok("max dictation 1.26e6 ms @main:230575", main.slice(230570, 230580).join(" ").includes("g > 126e4"));
ok("no-audio 5s watchdog @main:230561", main.slice(230558, 230566).join(" ").includes("5e3"));
ok("synthetic 640-zero chunks vol -200 @hub:38026-38040", hub.slice(38025, 38042).join(" ").match(/Int16Array\(640\)\.fill\(0\)[\s\S]*volume: -200[\s\S]*synthetic: !0/) !== null);
ok("opus duration 20 @hub:38311", at(hub, 38311, "duration: 20"));
ok("audioPackets items @main:201757", main.slice(201755, 201760).join(" ").includes("items: e.packets.map((e) => new Uint8Array(e))"));
ok("silent chunks before first audio dropped @hub:37842-37846", hub.slice(37838, 37848).join(" ").match(/before first real audio - discarding[\s\S]*countsSilenceBeforeFirstAudio\)\s*\)\s*return/) !== null);

// 2. Execute the REAL worklet source in a mock and check chunking
const src = fs.readFileSync(P("work/app/.webpack/renderer/dist/recorderWorklet.js"), "utf8");
const posted = []; let ctor;
const ctx = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } }, registerProcessor: (n, c) => { ctx.name = n; ctor = c; }, Float32Array, Uint16Array, Set, Array };
vm.createContext(ctx); vm.runInContext(src, ctx);
ok("registerProcessor name", ctx.name === "recorder-processor");
const w = new ctor({ numberOfInputs: 1 });
w.port.onmessage({ data: "start" });
let n = 0;
for (let q = 0; q < 13; q++) { const f = new Float32Array(128).fill(0.5); w.process([[f]]); n++; } // 1664 samples
const lens = posted.filter((m) => typeof m !== "string").map((m) => m[0].length);
ok("full chunks are 640 samples", lens.length >= 2 && lens.slice(0, 2).every((l) => l === 640), JSON.stringify(lens));
// 128-quantum into 640 buffer: flush happens before overflow => first chunk is 640 only if 5*128=640 exactly
ok("5 quanta == one chunk (5*128=640)", lens[0] === 640);
w.port.onmessage({ data: "stop" });
const tail = posted.filter((m) => typeof m !== "string").pop()[0].length;
ok("stop flushes partial tail then 'recorderWorklet:done'", posted.at(-1) === "recorderWorklet:done" && tail === 1664 - 2 * 640, `tail=${tail}`);

// 3. Meter reference implementation self-check (matches doc pseudocode)
const dB = (x) => 20 * Math.log10(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) + 1e-10);
ok("full-scale square = 0 dBFS", Math.abs(dB([1, -1, 1, -1])) < 1e-6);
ok("silence = -200 dB", Math.abs(dB([0, 0]) + 200) < 1e-6);
const mk = (floor0 = 0, minF = -60, span = 20) => { let f = floor0; return (r) => { if (r < f) f = Math.max(minF, r); return Math.max(0, Math.min(1, (r - f) / span)); }; };
const sc = mk(); sc(-200);
ok("scaler: -200 dB -> 0 and floor -60", sc(-60) === 0);
ok("scaler: -50 dB -> 0.5 (floor -60)", Math.abs(sc(-50) - 0.5) < 1e-9);
ok("scaler: -30 dB clamps to 1", sc(-30) === 1);
console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
process.exit(fail ? 1 : 0);
