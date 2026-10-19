// Falsifiable checks for docs/04-status-pill-gui.md. Run: node tools/gui-verify.mjs
// Reads work/pretty/** (read-only). Exits 1 if any claim fails.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (f) => path.join(root, "work/pretty", f);
const main = fs.readFileSync(P("main/index.js"), "utf8");
const rend = fs.readFileSync(P("renderer/status/index.js"), "utf8");
let fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!cond) fail++;
};
const has = (src, s) => src.includes(s);
const slice = (src, startRe, endRe) => {
  const a = src.search(startRe);
  if (a < 0) throw new Error("start not found " + startRe);
  const rest = src.slice(a + 10);
  const b = rest.search(endRe);
  return src.slice(a, a + 10 + (b < 0 ? rest.length : b));
};
const lineOf = (src, s) => src.slice(0, src.indexOf(s)).split("\n").length;

// ---- 1. Window options (main) ----
const win = slice(main, /const H = \(\) => \{\s*const e = i\.screen\.getDisplayNearestPoint/, /r\.setMaxListeners\(15\)/);
for (const s of ['title: "Flow Status Indicator"', "transparent: !0", 'backgroundColor: "#00000000"', "hasShadow: !1",
  "roundedCorners: !1", 'M.tD ? "panel" : "toolbar"', "skipTaskbar: !0", "focusable: d.ty.allowBubbleFocus", "frame: !1",
  "alwaysOnTop: !0", "hiddenInMissionControl: !0", "backgroundThrottling: !1", "movable: !1", "resizable: !1",
  'setAlwaysOnTop(!0, "screen-saver")', "setVisibleOnAllWorkspaces(!0", "visibleOnFullScreen: !0", "setIgnoreMouseEvents(!0, { forward: !0 })"])
  ok(`window: ${s}`, has(win, s));
ok("window: shown with showInactive (never show/focus)", has(main, "e.showInactive()") && !/statusWindow\.show\(\)/.test(main));

// ---- 2. Geometry: evaluate the real placement module ----
const geoSrc = slice(main, /\n        58601\(e, t, n\) \{/, /\n        76127\(e, t, n\) \{/);
const body = geoSrc.slice(geoSrc.indexOf("{") + 1, geoSrc.lastIndexOf("}"));
const exportsObj = {};
const nStub = (id) => (id === 54103 ? { DR: 2 } : {});
nStub.d = (t, defs) => { for (const k in defs) Object.defineProperty(t, k, { get: defs[k], enumerable: true }); };
new Function("e", "t", "n", body)({}, exportsObj, nStub);
// exports are minified: s2=placement, R1=614, yM=512, Du={490,1144}
ok("geometry constants R1=614 yM=512 Du=490x1144", exportsObj.R1 === 614 && exportsObj.yM === 512 && exportsObj.Du.width === 490 && exportsObj.Du.height === 1144);
const disp = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 25, width: 1920, height: 1015 }, workAreaSize: { width: 1920, height: 1015 } };
const bottom = exportsObj.s2(disp, { isVisible: true }, "bottom", true, false, 614, exportsObj.Du, 512);
ok("mac bottom dock => 512x614 window, centered, flush with work-area bottom",
  bottom.width === 512 && bottom.height === 614 && bottom.x === (1920 - 512) / 2 && bottom.y + bottom.height === 25 + 1015, JSON.stringify(bottom));
const left = exportsObj.s2(disp, { isVisible: true }, "left", true, false, 614, exportsObj.Du, 512);
ok("left edge => 490 wide, x=0, vertically centered", left.width === 490 && left.x === 0 && left.y === 25 + (1015 - left.height) / 2, JSON.stringify(left));
const winBottom = exportsObj.s2(disp, { isVisible: true }, "bottom", false, true, 614, exportsObj.Du, 512);
ok("windows: work-area height reduced by DR=2 before anchoring", winBottom.y + winBottom.height === 25 + 1015 - 2, JSON.stringify(winBottom));

// ---- 3. Follow-cursor monitor poll ----
ok("monitor poll every 400ms", has(main, "We = () => setInterval(Pe, 400)"));
ok("display = nearest to cursor", /r = n\(e\(\)\)/.test(main) && has(main, "getCursorScreenPoint"));
ok("bounds animate only if move <100px", has(main, "Math.abs(Z.x - c.x) < 100") && has(main, "Math.abs(Z.y - c.y) < 100"));

// ---- 4. Click-through alpha poll ----
const hit = slice(main, /\n        16815\(e, t, n\) \{/, /\n        78704\(e, t, n\) \{/);
ok("hit-test default poll 400ms, threshold 0", has(hit, "I = (e, t = 0, n = 400)"));
ok("hit-test captures 1x1 px at cursor", has(hit, "width: 1,") && has(hit, "capturePage(r)"));
ok("alpha read from BGRA byte[3]", has(hit, "b[3]") && has(hit, "A = b[3]"));
ok("threshold raised to >=127 when catch-rects registered", has(hit, "Math.max(t, 127)"));
ok("opaque => capture, transparent => forward", has(hit, "I(A <= v, n)") && has(hit, "setIgnoreMouseEvents(!0, { forward: !0 })") && has(hit, "e.setIgnoreMouseEvents(!1)"));
ok("hit-test started on non-feature-tour show: ne() calls Bi", /V = \(0, g\.Bi\)\(e\)/.test(main));
ok("windows uses setShape with <=128 rects", has(main, "slice(0, 128)") && has(main, "t.setShape(e)"));
ok("renderer hotspot alpha ~0.004 (=1/255) catch area", has(rend, "rgba(0,0,0,.004)"));

// ---- 5. IPC channels ----
for (const c of ["status:audioLevel", "status:dictationStatus", "status:micActive", "status:micSilence", "status:popo",
  "status:setIndicatorState", "status:commandModeStatus", "status:instructModeStatus", "status:monitorChanged",
  "status:playPasteSound", "status:reportAlphaCatchRects", "status:startClicked", "status:stopClicked", "status:cancelClicked",
  "status:barHidden", "status:barVisible", "status:dockPosition", "notification:enableMouseEvents"])
  ok(`channel ${c} in main and renderer`, has(main, `"${c}"`) && has(rend, `"${c}"`));
ok("audio level batched every 150ms and averaged", has(main, "}, 150));") && has(main, "Rn.reduce((e, t) => e + t, 0) / Rn.length"));
ok("audio level sent to status window (nB)", has(main, "(0, y.Bn)(e, m.LF.AudioLevel, t)"));
ok("preload exposes generic ipc (no whitelist)", has(fs.readFileSync(P("renderer/status/preload.js"), "utf8"), 'exposeInMainWorld("electron", ft)'));

// ---- 6. Level scaler (adaptive floor): evaluate vendor code ----
const sc = main.match(/_ = -60,\s*E = \(e = _, t = 20\) => \{[\s\S]*?getCurrentFloor: \(\) => n,\s*\};\s*\}/);
ok("scaler source found", !!sc);
const scaler = new Function(sc[0].replace(/^_ = -60,\s*E =/, "const _ = -60; const E =") + "; return E;")();
const s = scaler();
const seq = [-40, -30, -20, -50, -30]; // dB RMS
const out = seq.map((x) => +s.scale(x).toFixed(3));
ok("scaler: first sample 0 (floor snaps to it), rises 1/20 per dB, floor only decreases", JSON.stringify(out) === JSON.stringify([0, 0.5, 1, 0, 1]) && s.getCurrentFloor() === -50, JSON.stringify(out));
ok("scaler clamps floor at -60", (() => { const q = scaler(); q.scale(-90); return q.getCurrentFloor() === -60; })());
ok("gain 5 normal / 2 meeting; floor of 1", has(rend, "gain: i ? 2 : 5") && has(rend, "Math.max(1, a)"));
ok("smoothing 0.85 per frame (non-ticker)", has(rend, "0.85 * e + t * (1 - 0.85)"));
ok("ticker: pow(0.85, dt/(1000/60)) and slew 1.6/s", has(rend, "Math.pow(0.85, n / xl)") && has(rend, "(n / 1e3) * 1.6") && has(rend, "xl = 1e3 / 60"));
ok("default 10 bars, bulge 1; quad falloff /48", has(rend, "barCount: l = 10") && has(rend, "bulgeCoefficient: _ = 1") && has(rend, "Math.pow(h, 2) * (_ / 48)"));
ok("bar delay 0.1*offset with offsets p<ceil(n/2)?p:p-n", has(rend, "t < p ? t : t - l") && has(rend, '0.1 * m[p] + "s"'));
ok("wobble keyframes 1/1.2/1.5/1.1/1.3 @0/20/40/80/90%", has(rend, "scaleY(calc(var(--audio-scale, 1) * var(--bar-height-scale, 1) * 1.5))") && has(rend, "20%{transform:scaleY(calc(var(--audio-scale, 1) * var(--bar-height-scale, 1) * 1.2))}40%"));
ok("wobble period 1s ease-in-out infinite", has(rend, "animation:__sN13fyFt35sDlqeeLV 1s infinite ease-in-out"));
ok("mini waveform has 5 bars with gains .8/1/1.2/1/.8", has(rend, "levelGain: 0.8, delayS: 0.2") && has(rend, "levelGain: 1.2, delayS: 0.4"));
ok("processing spinner 8 spokes, 1.1s, -6px radius", has(rend, "Array(8)") && has(rend, "translate(0, -6px)") && has(rend, "linear infinite") && has(rend, "0.1375 * -(7 - i)"));

// ---- 7. State machine facts ----
for (const [k, v] of Object.entries({ HIDDEN: "hidden", RESTING: "resting", READY: "ready", ACTIVE_PTT: "active_ptt", ACTIVE_POPO: "active_popo", PROCESSING: "processing", ERROR: "error", INITIALIZING: "initializing" }))
  ok(`indicator state ${k}="${v}"`, has(rend, `(e.${k} = "${v}")`));
ok("error auto-resets after 500ms", /Error status received[\s\S]{0,400}setTimeout\(\(\) => xt\(S\), 500\)/.test(rend));
ok("polish-completed/NA timers 750ms", (rend.match(/\}, 750\)/g) || []).length >= 2);
ok("hover debounce lock 100ms, tooltip 50ms", has(rend, "nr = 50,") && has(rend, "ir = 100;"));
ok("popo (locked) sound uses popoLock; paste sound on event", has(rend, "Bh(c.user.selectedSoundFolder, (e) => e.popoLock)") && has(rend, "(e) => e.paste"));
ok("start/stop sounds are routed to hubWindow, not status", has(main, "(0, w.Bn)(E.RA.hubWindow, f.Y6.PlayDictationStartSound)") && has(main, "(0, w.Bn)(E.RA.hubWindow, f.Y6.PlayDictationStopSound)"));
ok("pill CSS sizes (bottom): resting 40x8, ready 50x30, ptt 73x30, popo 102.5x30, processing 98x30, error 91x30",
  ["width:40px;height:8px", "width:50px;height:30px", "width:73px;height:30px", "width:102.5px;height:30px", "width:98px;height:30px", "width:91px;height:30px"].every((x) => has(rend, x)));
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
