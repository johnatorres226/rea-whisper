# 04 - Status pill ("Flow bar") GUI

Scope: the small floating indicator the subject app 1.6.1102 shows while dictating. All citations are `path:line` relative to `work/pretty/`. Vendor names in the minified code (`Ce`, `Sl`, `v_`) are given only as locators. Everything below is a description in my own words; the checks in "Validation" re-derive the numbers from the source.

## 1. Overview

The pill is not a native widget. It is a **transparent, borderless Electron window** titled "Flow Status Indicator" (`main/index.js:343283-343331`) that hosts a React page (`renderer/status/index.js`). The window is much bigger than the visible pill (512x614 px for a bottom-docked bar, `main/index.js:344074-344153`) and is almost entirely transparent. The page draws the pill (a black rounded rectangle) near the window's lower edge. Mouse clicks only land on the pill because the main process turns "ignore mouse events" on and off depending on whether the pixel under the cursor is opaque (section 5).

Key facts:

- One window for the lifetime of the app. It is created and shown inactive at app start (`main/index.js:171850` calls the show helper `J` at `343455`) and is never hidden between dictations. "Hidden" and "resting" are renderer states (CSS opacity or a tiny 40x8 capsule), not window visibility.
- Dictation state, audio level, mic readiness and hands-free ("popo") events reach it over plain Electron IPC (`webContents.send`) on `status:*` channels (section 4).
- The bars are CSS-driven: JS sets one CSS variable `--audio-scale` at ~60 fps; each bar is a `div` scaled with `transform: scaleY(...)` and a looping CSS keyframe wobble. No canvas, WebGL, SVG or Lottie is involved in the waveform.
- Start/stop sounds are NOT played by the pill window (section 7).

### ASCII sketch (bottom dock; sizes are CSS px, `renderer/status/index.js:26331+`)

```
 window 512x614 (transparent, click-through except over pill)
 +--------------------------------------------------+
 |                                                  |
 |                                                  |
 |                 ...tooltips/bubbles...           |
 |                                                  |
 |                    ___40x8___                    |  RESTING   (dim capsule, 50% black, 1px 50% white border)
 |                   (_________)                    |
 |                                                  |
 |                   [ (mic)  ]  50x30              |  READY     (cursor hovers pill; mic glyph; tooltip after 150ms)
 |                [x] ||||||||||  [stop]  73x30     |  ACTIVE_PTT (cancel, 10 bars, stop)
 |           [x]  ||||||||||  [stop] [..]  102.5x30 |  ACTIVE_POPO (hands-free/locked; wider)
 |              ||||||||||  (spinner)  98x30        |  PROCESSING (bars flat + 8-spoke spinner)
 |               ( error, red 1.5px border ) 91x30  |  ERROR
 +--------------------------------------------------+  <- work-area bottom edge (mac) / minus 2px (Windows)
```

Left/right docking swaps width and height (e.g. PTT is 30x73, popo 30x102.5) and rotates the bars to `scaleX` (`renderer/status/index.js:25866`, `[data-bar-position=left|right]` rules).

## 2. Window specification

Created in `main/index.js:343283-343331` (`H()`), then configured immediately after (343326-343358).

| Option / call | Value | Purpose |
|---|---|---|
| `show` | false, then `showInactive()` (`main/index.js:343461`) | Show without activating the app or stealing focus |
| `transparent`, `backgroundColor` | true, `#00000000` | Per-pixel alpha so only the pill is visible and hit-testable |
| `hasShadow`, `roundedCorners` | false, false | No OS shadow/corners around the transparent canvas |
| `frame`, `titleBarStyle` (mac) | false, `hidden` | Borderless |
| `type` | `panel` on macOS, `toolbar` otherwise | macOS: NSPanel (non-activating, floats over fullscreen). Others: tool window |
| `title` | "Flow Status Indicator" | Used by logs/diagnostics |
| `focusable` | `allowBubbleFocus` (a CLI debug flag, default false) | Normally the window can never become key |
| `skipTaskbar` | true | No taskbar/Dock entry |
| `hiddenInMissionControl` (mac) | true | Not shown in Mission Control |
| `alwaysOnTop` + `setAlwaysOnTop(true,"screen-saver")` | true | Highest normal level, above fullscreen apps |
| `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true, skipTransformProcessType:true})` (mac only) | | Appear on every Space and over fullscreen apps without changing the app's activation policy |
| `setFullScreenable(false)`, `fullscreen/fullscreenable/maximizable/minimizable/resizable/movable/closable` | false | Nothing the user could do to it natively |
| `webPreferences.backgroundThrottling` | false | Keep timers/rAF running while the window is "occluded" or unfocused |
| `webPreferences` base (`main/index.js:344384`) | `nodeIntegration:false, contextIsolation:true, sandbox:false, webgl:false` | Standard hardening; preload at `renderer/status/preload.js` |
| `setIgnoreMouseEvents(true,{forward:true})` | non-Windows at creation; Windows via `replaceWindow()` which also does this and `setShape([])` | Click-through by default; `forward` still delivers mouse-move to the page so hover can be detected |
| `setContentProtection(bool)` | true while a meeting is recording AND pref `hideMeetingRecorderInScreenShare` | Keep the pill out of screen shares |
| macOS 27 native `preventActivation(nativeHandle)` (`panel_activation.node`, module `86445`) | only if macOS major == 27, feature flag `macos-27-panel-nonactivation` is on (default OFF, `main/index.js:323990`), and `allowBubbleFocus` false | Belt-and-braces: ask AppKit to refuse activation for this panel. Result logged as `applied` or `refused` |

Other lifecycle hooks on the window: `render-process-gone` resets click-through and the hit-test poll (343370-343388); `unresponsive` cancels auto-start (343366); `did-finish-load`/`show` re-pulse bounds (see "surface recovery" below).

### Geometry

`Ce(display)` (`main/index.js:343672`) delegates to `s2` in module 58601 (`344074-344153`). Inputs: display (Electron `bounds`, `workArea`, `workAreaSize`), dock info, configured edge (default `"bottom"`, pref `statusDockEdge`, `main/index.js:155327`), platform flags.

- Start from the display's work area (`d`, 344100-344112): x = display.bounds.x (+ left dock inset on mac), y = bounds.y + menu-bar inset (`workArea.y - bounds.y`), width = workAreaSize.width (+ left/right dock inset when the Dock is hidden), height = workAreaSize.height (+ dock height when hidden). Windows subtracts `DR = 2` px from the height (`renderer/status/index.js:136`, `main/index.js:143239`) so the window never exactly covers the screen.
- Bottom edge (default): window is **512 wide x 614 tall**, horizontally centered in that area, bottom flush with its bottom (`x + (w-512)/2`, `y + h - 614`).
- Left/right edge: window is **490 wide x min(1144, areaHeight)** tall, flush to the chosen side, vertically centered.
- A reminder surface can force `"bottom"` (343678-343697).
- "Which display": the one nearest the mouse cursor (`getDisplayNearestPoint(getCursorScreenPoint())`, 343283-343287 and 343777). A mutex-guarded poll runs **every 400 ms** (`We`, 343844) and rewrites bounds when the computed rectangle changed (`setContentBounds(rect, animate)`); `animate` is true only when the move is < 100 px in both axes and no dock-transition fade is active (343812-343836). So the pill follows the cursor across monitors, with a fade-in after a Dock show/hide.
- Dock visibility comes from the native helper via gRPC `DockInfoUpdate` (`main/index.js:239105-239125`); a visibility change triggers an immediate relayout.
- Drag-to-redock: renderer starts a drag after a 5 px mouse move (`renderer/status/index.js:4165`), main enters a drag overlay mode (`Ue`, 343877) using a full-display window (`Iz`), registers a global Escape shortcut to cancel, and on drop stores `statusDockEdge` (`E.LF.DockPosition`, 344067).

### Surface recovery (Windows-centric, but code is cross-platform)

Because a transparent always-on-top window can silently stop compositing, main probes it with a 1x1 `capturePage` (4 s timeout) every 3 s after show and 60 s when healthy (`oe=3e3`, `ae=6e4`; `_t` at `main/index.js:344320`; probe loop `343640-343660`). Recovery ladder: invalidate + 1px content-bounds "pulse" (+1 height for 150 ms, `de` 343553) -> hide/show -> rebuild window. Not needed for a re-implementation but explains the odd `setContentBounds` churn.

## 3. State machine

Two layers exist.

### 3a. Main process dictation status (`_W` enum, `main/index.js:143735` / `renderer/status/index.js:~215`)

`initializing, listening, stopping, processing, dismissed, retrying, error, idle, testing`. Main broadcasts every change with `webContents.send("status:dictationStatus", status)` (`main/index.js:234269`, `Pe()` at 234226), unless the route owns the bubble (`skipBubbleIPC`). Polish adds `polish_processing | polish_completed_na | polish_completed_action | polish_failed` on the same channel; `toggle_hotkey_reminder` and `instruct_chat_active/inactive` also arrive here.

### 3b. Renderer indicator state (`fw` enum, `renderer/status/index.js:152-171`)

`hidden, resting, context-menu, initializing, ready, active_ptt, active_popo, processing, polish_processing, polish_completed_action, polish_completed_na, polish_failed, auto_cleanup_completed, hotkey_reminder, instruct_completed, error`.

Reducer: `renderer/status/index.js:10435-10500`. Event mapping: `renderer/status/index.js:18697-18870`.

| From | Trigger (IPC / event) | To | Notes / timing |
|---|---|---|---|
| hidden | pref change: `hideFlowBarPermanently` false and snooze elapsed | resting | tells main `status:barVisible` which restarts hit-testing (343430-343440) |
| resting | pref hides bar | hidden | tells main `status:barHidden` -> click-through forced on |
| resting | pointer enters hot area | ready | hover is debounced; 100 ms lock (`ir`); BUBBLE tooltip armed 150 ms (`19457`) |
| ready | pointer leaves | resting | |
| ready | right-click | context-menu | opens separate context-menu window |
| any rest state | `dictationStatus=initializing` | initializing | main starts audio; waveform cleared |
| initializing/idle | `dictationStatus=listening` | active_ptt | unless already active_popo (reducer keeps popo) |
| active_ptt | `status:popo` (hands-free lock engaged, `main/index.js:234400`) | active_popo | plays `popoLock` sound if enabled (18877) |
| active_* | `stopping` or `processing` or `retrying` | processing | `re.current=Date.now()` for timing log; waveform cleared (bars flatten) |
| processing | `idle` | resting or hidden (`restState`) | |
| any | `dismissed` | resting/hidden (immediately) | user cancel |
| any | `error` | error, then `resetToRestingOrHidden` after **500 ms** | (18816-18823); notification-driven errors use the same state |
| any | `polish_processing` | polish_processing | |
| polish_processing | `polish_completed_na` / `polish_failed` | resting after **750 ms** | |
| polish_processing | `polish_completed_action` | polish_completed_action after 750 ms, back to rest after **5 s** (`Pt`) unless hovered | |
| any | auto cleanup notice (`status:setIndicatorState`, `AUTO_CLEANUP_COMPLETED`) | auto_cleanup_completed -> rest after **7 s** (first 3 times) or **5 s** | |
| any | `toggle_hotkey_reminder` | hotkey_reminder -> rest after **5 s** | |
| resting | `instruct_chat_active` | instruct_completed (morph) | collapses to rest after 300 ms when finished |
| (meeting recording) | meeting phase != idle | effective state forced to active_popo look (`A_`, 14111) | meeting chrome shows timer/stop button |

Cancel button click: `status:cancelClicked` with reason `UserActionCancelButton`, then immediate reset to rest. Stop button: `status:stopClicked`. Start (from the READY pill): `status:startClicked`. All three are handled in main at `343923-343929` and route to the same dictation controller as hotkeys. The Escape/hotkey path never goes through the pill.

Mic readiness sub-state (affects only bar look, `renderer/status/index.js:18552-18650`):
- `status:micActive(true)` (sent on the first audio chunk, `main/index.js:230475`) -> bars become white and wobble animation turns on.
- `status:micSilence(true)` (silence warning) -> animation and white fill off (bars gray, flat); `false` -> back on.
- Before the first chunk, bars are gray `hsla(0,0%,100%,.4)` and static.

Minimum display durations: no explicit minimum for listening/processing; pill stays in `processing` until main sends `idle`. Only the post-event timers above (500 ms, 750 ms, 5 s, 7 s, 300 ms) exist.

## 4. IPC and data path

Window creation ties preload to `renderer/status/preload.js`. The preload exposes a **generic** bridge, not a per-channel whitelist: `window.electron.ipc.{invoke,send,on,off}` (`renderer/status/preload.js:3108-3134`) and a `zubridge` redux bridge (`:3684`) used for prefs/meeting state. The page therefore listens on the raw channel strings below.

Main -> pill (`webContents.send`, enum `LF` at `main/index.js:145641-145667`):

| Channel | Payload | Producer / rate |
|---|---|---|
| `status:audioLevel` | number 0..1 | dictation audio handler (`main/index.js:230465-230495`); one send per **150 ms** (`setInterval` created on first chunk), value = mean of chunk-scaled levels collected in that window |
| `status:dictationStatus` | status string | every state transition (234269) |
| `status:micActive` | boolean | first audio chunk (230475); also from `LF.MicActive` handler |
| `status:micSilence` | boolean | silence detector (344236-344245) |
| `status:popo` | none | hands-free lock engaged (234400, 234539, 234640) |
| `status:commandModeStatus` / `status:instructModeStatus` | boolean | switches bar color (command = `#ffa946`, instruct = `--signal-500`) |
| `status:setIndicatorState` | `{state}` | e.g. auto cleanup (230192), reminders |
| `status:monitorChanged` | none | pill moved to another display (343798) |
| `status:setBlackoutOverlay`, `status:setDragOverlay`, `status:dockPosition`, `status:startFlowBarMoveHint` | `{isActive,...}` | overlay / dock-drag UX |
| `status:playPasteSound` | none | text pasted (233318) |
| `notification:show/clear` | notification object | toasts above the pill; `shouldAnimate`/`timeout` (default constant `ew`) |

Pill -> main (`ipc.invoke/send`, enum `EB` at 145703-145725): `status:windowReady`, `startClicked`, `stopClicked`, `cancelClicked`, `barHidden`, `barVisible`, `snoozeClickableBubble`, `snoozeContextualNudge`, `triggerPolish`, `viewPolishDiff`, `polishFeedback`, extension-bubble channels, and `status:reportAlphaCatchRects` (clickable rectangles). `notification:enableMouseEvents(bool)` lets the page force capture on/off (344020).

Audio value computation (main, before sending):
1. The native helper reports each audio packet with `volume` in dBFS-like units (RMS dB, compare `20*log10(rms)` helper at `main/index.js:156700`).
2. A per-session **adaptive-floor scaler** (`main/index.js:156728-156741`, instance created at 229073) maps dB to 0..1.
3. The 150 ms timer averages the scaled values and sends the mean.

## 5. Click-through and focus

### Why it never steals focus
- macOS: `type:"panel"` creates a non-activating NSPanel; `focusable:false` stops it from becoming key; `showInactive()` is the only show call used; `setVisibleOnAllWorkspaces` is passed `skipTransformProcessType:true` so Electron does not flip the app between regular/accessory policy; optional native `preventActivation` as extra on macOS 27.
- Windows: `focusable:false` makes Electron set `WS_EX_NOACTIVATE`; `skipTaskbar`, always-on-top "screen-saver". `focus()` is only called on the hub window helper (`z` at 344518), never on the pill.
- Every mouse interaction is forwarded as a normal click to the page; the target app keeps keyboard focus because the panel cannot become key.
- If `allowBubbleFocus` (CLI debug flag, `main/index.js:330656`) is set, the window becomes focusable (debug only).

### Alpha hit-test (the "lastAlphaCheck" mechanism)
Module 16815 (`main/index.js:344301-344560`), function `Bi(window, threshold=0, intervalMs=400)`. It decides, for the current cursor position, whether the window should capture mouse events or let them fall through. Steps (`k()` in the code):

1. Runs on a 400 ms interval and whenever `forceRecheck()` is called (after the page reports new rectangles, on `status:barVisible`, `enableMouseEvents`, etc.). Skips if a previous run is in flight (re-runs once after).
2. If the app system state is not `active`, forget the last cursor position and bail.
3. Get cursor in screen coordinates and window bounds. If the cursor is outside the window: set ignore (`setIgnoreMouseEvents(true,{forward:true})`). On Windows additionally synthesize a `mouseLeave`.
4. If inside: compute window-relative point. Lists consulted in order:
   a. exclusion rects (registered via `rX`) -> ignore;
   b. "catch rects" reported by the page (`cM`, elements marked `data-alpha-catch`) -> **capture** (`setIgnoreMouseEvents(false)`), logged decision `"catch-rect"`;
   c. shape rects (`cr`, Windows only) -> ignore (those are handled by the native shape).
5. If the cursor has not moved since the last sample, do nothing.
6. Otherwise `webContents.capturePage({x,y,width:1,height:1})` - a one-pixel screenshot of the page's own composited output. Take `bitmap[3]` (alpha of the BGRA pixel). Threshold = 0 normally, **max(threshold,127)** once the page has registered catch rects. If `alpha <= threshold` -> ignore (click-through); else capture. The result is saved in `lastAlphaCheck {decision, cursorPos, BGRA, alpha, appliedThreshold, timestamp}` which is printed on every mouse-down for diagnostics (`main/index.js:343404-343415`).
7. Race guards: a generation counter and a re-check that cursor and window bounds are unchanged after the async capture; on capture failure it falls back to catch-rect-only decisions and invalidates the page.

The page keeps hover/click targets alive on otherwise transparent pixels by painting a **nearly invisible** background (`rgba(0,0,0,.004)`, i.e. alpha 1/255) on the "hot area" around the pill (`renderer/status/index.js:26340`, `.hotArea`) plus a 12px halo while READY. With threshold 0 these count as opaque; with threshold 127 (once catch rects exist) only listed rects and visibly painted pixels (black pill) capture.

Windows uses a second mechanism in parallel: the page reports rectangles (`status:reportAlphaCatchRects` payload `{rects, shapeRects, viewport}`, validated: finite numbers, <= 512 rects each, viewport must match window size within 2 px, `main/index.js:344172-344215`) and main calls `BrowserWindow.setShape(rects)` (max 128 rects) so the OS itself clips input to those regions (`main/index.js:344154-344300`, class `m`). The feature tour window suspends the poll (`ie/se`, 343489-343510).

## 6. Waveform algorithm

Rendering technique: **N DOM `div` bars scaled with CSS `transform: scaleY()`**, one CSS custom property per container, plus a CSS keyframe wobble per bar. (Lottie assets in `assets/lottie` - `pulsing_circle.json`, `celebration.json` - are not used by the pill.)

Bars (main pill): `v_` at `renderer/status/index.js:13951-14068`. Defaults `barCount = 10`, `bulgeCoefficient = 1`; a second use passes 5 bars and bulge 18 (14975). A separate 5-bar "mini waveform" `O_` (14217) is used inside instruct mode.

Constants:
- Bar: width 2 px (`--waveform-bar-width`), min-height 2 px, radius 0.5 px, gap 2 px, container padding 8px 4px (bottom dock) so the resting bar is a 2x2 dot. Fill gray `rgba(255,255,255,.4)`; white once mic active; command mode `#ffa946`; instruct `--signal-500`; dark-scheme variant black-ish (`renderer/status/index.js:25866`).
- Center weighting: `h = |(N-1)/2 - i|`; `weight = max(0, 1 - h^2 * (bulge/48))` (for `bulge >= 2` the exponent is 1: `1 - h*(bulge/48)`). For N=10, bulge=1 the weights are 1 - (4.5..0.5)^2/48 = 0.578 ... 0.995.
- Per-bar wobble: CSS keyframes over 1 s, `ease-in-out`, infinite; multiplier 1.0 @0%, 1.2 @20%, 1.5 @40%, 1.1 @80%, 1.3 @90%, 1.0 @100%. Phase offset per bar: `animation-delay = 0.1 * off_i` seconds where `off_i = i` for `i < ceil(N/2)` else `i - N` (so delays 0,0.1,0.2,0.3,0.4,-0.5,-0.4,-0.3,-0.2,-0.1 for N=10). Wobble is only active when `showWaveformAnimation` (mic active) is true; with `prefers-reduced-motion` the mini bars disable it.
- Height: `scaleY = audioScale * weight * wobble`, where `audioScale = max(1, GAIN * level_smoothed)` and `GAIN = 5` (normal) or 2 (meeting chrome). So silence = 2px dots (scale 1); full-scale speech reaches 10 px x 1.5 wobble = 15 px at the center bars. (`renderer/status/index.js:18613-18620` for gain; `13082` hook.)
- Smoothing (`Sl`, 13082-13170): on each `status:audioLevel` the raw value is stored as the target. A per-frame loop (requestAnimationFrame, stops when both target and value are 0 or the page is hidden) does `v = floor(100 * (0.85 * v + 0.15 * target)) / 100` - a one-pole low-pass at 0.85 per frame (about 60 Hz => time constant ~100 ms). Because values arrive every 150 ms, bars drift toward each new target rather than jumping. Clearing the waveform (processing, silence, idle) sets target 0 so bars fall back to 1x. The CSS variable is written only when the string value changes.
- "Ticker" mode (meeting chrome only): shared scheduler at **20 fps** (`_l = 20`, 13023-13060, rAF + setTimeout hybrid) with time-based smoothing `a = prev*0.85^(dt/16.67) + target*(1-...)`, then a slew limit of 1.6 units/second; plus a procedural bar multiplier curve `vl(k_, (t - 0.1*off)/1)` with smoothstep between points (0,1),(.2,1.2),(.4,1.5),(.8,1.1),(.9,1.3),(1,1) driving `--wave-mult` (13940-14000). Meeting bars use clip-path instead of transform.
- Idle animation: none while silent in dictation (bars are 2 px dots; wobble also scales 1 -> still 2 px x multiplier 1.5 = up to 3 px only when mic active and audio-scale >=1, so a faint 2-3 px shimmer remains once the mic is active).
- Processing: bars cleared; an **8-spoke spinner** (`Bl`, 13354): spokes 2x5 px, `rotate(45*i deg) translate(0,-6px)` in a 16x16 box, each fading from rgba(163,148,199,.88) to .15 over **1.1 s linear infinite**, delay `-0.1375 * (7 - i)` s. Colors: command `rgba(255,169,70,.3)` base, instruct `--signal-500`. In instruct mode the processing content is a shimmering text label instead (`N_`, 14140).
- Level scaler in main (`main/index.js:156728`): state `floor` starts 0 at dictation start (`En.reset()`, 230660); for each dB sample `x`: `if x < floor: floor = max(-60, x)`; `level = clamp((x - floor) / 20, 0, 1)`. The floor therefore only ever moves down during a session (it learns the quietest sample), so the first sample is always 0 and a 20 dB rise above the quietest sample is full scale. A fixed range is used for mic test: `clamp((dB + 50)/40)` (`main/index.js:156742`).

Pseudocode:

```
# --- main process (per audio packet, ~tens of ms) ---
on_packet(volume_db):
    if status == Testing: send(hub, level = clamp((volume_db + 50) / 40))
    lvl = scaler.scale(volume_db)               # adaptive floor, see below
    pending.append(lvl)
    if not timer: timer = every 150 ms: send(pill, "status:audioLevel", mean(pending)); pending.clear()

scaler: floor = 0                               # reset() at dictation start
    scale(x): if x < floor: floor = max(-60, x)
              return clamp((x - floor) / 20, 0, 1)

# --- pill ---
BARS=10; BULGE=1; GAIN=5
weight[i]  = max(0, 1 - (|(BARS-1)/2 - i|^2) * BULGE/48)
phase[i]   = 0.1 * (i if i < ceil(BARS/2) else i - BARS)          # seconds
wobble(t)  = piecewise smoothstep/ease-in-out over 1 s:  {0:1, .2:1.2, .4:1.5, .8:1.1, .9:1.3, 1:1}   # loop

on audioLevel(x): target = x            # only accepted if state in {PTT, POPO} and not flushing
every frame (rAF, 60 Hz):
    live = state in {PTT, POPO}
    v = floor(100 * (0.85*v + 0.15*(live ? target : 0))) / 100
    scale = max(1, GAIN * v)
    for i in bars:
        h = scale * weight[i] * (mic_active ? wobble(now + phase[i]) : 1)
        draw bar i as 2 px wide, 2 px * h tall, centered vertically, gap 2 px
on state leaves PTT/POPO (stopping/processing/idle/dismissed/error): target = 0; v decays within ~0.5 s
on micSilence(true): stop wobble, bars gray, target = 0
```

Pseudocode for window placement:

```
every 400 ms (and on display-metrics-changed / dock change):
    d = display_nearest(cursor)
    area = workArea(d); if dock hidden (mac): extend by dock height and side insets
    area.y = d.bounds.y + menubar_height; if windows: area.h -= 2
    if edge == bottom: r = {x: area.x + (area.w-512)/2, y: area.y + area.h - 614, w:512, h:614}
    else:              w=490; h=min(1144, area.h); r = {x: edge==left ? area.x : area.right - w, y: area.y + (area.h-h)/2, w, h}
    if r != last: animate = (|dx|<100 and |dy|<100); window.setBounds(r, animate)
```

Pseudocode for click-through:

```
every 400 ms + on demand:
    p = cursor_screen(); b = window.bounds
    if p not in b: ignore_mouse(true); return
    q = p - b.origin
    if q in exclusion_rects: ignore_mouse(true); return
    if q in catch_rects:     ignore_mouse(false); return
    if p == last_p: return
    a = capture_window_pixel(q).alpha            # 1x1 screenshot of the window's own surface
    thr = catch_rects_defined ? 127 : 0
    ignore_mouse(a <= thr)                       # transparent => pass clicks to app below
```

## 7. Sounds and haptics

- Start and stop sounds: main receives `PlayDictationStartSound` / `PlayDictationStopSound` from the native helper over gRPC (`main/index.js:239015-239045`) and forwards `media:playDictationStartSound|StopSound` to the **hub** window, which plays them (`renderer/hub/index.js:3298-3299`). The pill does not play them. Files: `Resources/assets/sounds/<pack>/dictation-start.wav`, `dictation-stop.wav` (packs v1..v12, t1, notifv1/2; default pack at the folder root).
- Pill-played sounds: `popoLock` when hands-free lock engages (`renderer/status/index.js:18877`), `paste` on `status:playPasteSound` (19192), toast sounds at volume 0.5 (success/error/alert, 24111-24128). All gated on pref `enableSounds` and `selectedSoundFolder`; played with Howler (`new sm.t({src,autoplay,format:["wav"]})`).
- Haptics: none found in the pill (no Taptic/vibration calls).

## 8. Re-implementation notes

| Mechanism | macOS | Windows | Linux (best effort) |
|---|---|---|---|
| Overlay window | `NSPanel` with `.nonactivatingPanel` + `.borderless`; `isOpaque=false`, `backgroundColor=.clear`, `hasShadow=false`; `canBecomeKey=false` | Layered popup window (`WS_POPUP`), `WS_EX_LAYERED \| WS_EX_NOACTIVATE \| WS_EX_TOPMOST \| WS_EX_TOOLWINDOW` | layer-shell overlay or X11 override-redirect ARGB |
| Level | `window.level = .screenSaver` (CGShieldingWindowLevel-ish) | `SetWindowPos(HWND_TOPMOST)`; re-assert periodically (the vendor re-asserts on show/dictation start) | |
| All Spaces + over fullscreen | `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]` (+ `.stationary`/`.ignoresCycle` to hide from Mission Control) | automatic for topmost (exclusive fullscreen apps excepted; vendor shrinks height by 2 px so it is not treated as fullscreen) | |
| No focus steal | `orderFrontRegardless()`; never `makeKey`; app activation policy untouched | `ShowWindow(SW_SHOWNOACTIVATE)`, handle `WM_MOUSEACTIVATE` -> `MA_NOACTIVATE` | |
| Click-through | `ignoresMouseEvents=true` globally; toggle off when pointer over an interactive/opaque region. Cheaper than screenshotting: keep your own hit regions (pill rect, tooltip rects) or sample your backing bitmap's alpha at the cursor (what the vendor does); poll 100-400 ms or use a global mouse-moved monitor | `WS_EX_TRANSPARENT` toggled the same way, or `SetWindowRgn`/`UpdateLayeredWindow` per-pixel alpha (layered windows are already click-through at alpha 0), or the vendor's rect list via `SetWindowRgn` (max 128 rects) | input region |
| Placement | pick `NSScreen` containing `NSEvent.mouseLocation`; use `visibleFrame`; poll every 400 ms or observe screen changes; animate frame if move < 100 px | `MonitorFromPoint(cursor)` + `GetMonitorInfo.rcWork` | |
| Render | Any toolkit: 10 rounded rects, scale about their center; no GPU needed. Drive from a 60 Hz display link | same | |
| Audio level | Ship dB RMS from capture thread; apply scaler; average 150 ms; low-pass at 0.85/frame | same | |

Design advice: you do not need a screen-sized transparent window. Vendor uses it so tooltips, bubbles, a drag overlay and notifications can pop out without resizing; a native version can use a small window for the pill (50-100 x 30 px) and separate windows for menus.

## 9. Confidence and open questions

High confidence (verified in code and by scripts): window options, geometry numbers, 400 ms polls, alpha-hit-test algorithm and thresholds, IPC channel names and payloads, 150 ms level batching, scaler math, bar weights/phases/keyframes, smoothing constants, state enums, timers (500/750/5000/7000 ms), pill sizes, sound routing.

Medium: exact vertical placement of the pill inside the 614 px window (CSS root layout not fully traced; it looks flush to the bottom with tooltips stacked above); full set of `READY` hover buttons (language picker, polish wand, scratchpad, start-meeting) which depend on prefs/feature flags; which transitions trigger `HIDDEN` vs `RESTING` (depends on `hideFlowBarPermanently` and snooze prefs).

Low / not determined:
- The `volume` dB value definition inside the native helper (assumed RMS dB; the TS side only uses it as an opaque float; negative dB expected from the floor of -60).
- Whether Electron's `type:"panel"` sets exactly `NSWindowStyleMaskNonactivatingPanel` on all macOS versions (assumed from Electron docs; not verifiable from the bundle).
- The macOS-27 native module `panel_activation.node` was not disassembled.
- `_l=20` ticker fps: only used for meeting chrome; I did not check whether anything mutates it at runtime.
- Prototype (`prototypes/pill-waveform.html`) was not rendered in a browser in this session; the logic is a direct transcription of the pseudocode and relies on CSS `@property` (Chromium/Safari 16.4+).

## 10. Validation

All checks are in `tools/gui-verify.mjs` (plain Node, reads `work/pretty/**`). Each check asserts source text or evaluates the vendor function itself; changing a constant in the claim makes it fail (mutation run: replacing 400 with 500 and gain 5 with 6 gave `FAIL monitor poll every 400ms` and `FAIL gain 5 normal / 2 meeting`).

Run:

```
node tools/gui-verify.mjs
```

Recorded result (this session): 81 checks, all PASS, exit code 0. Highlights of the real-evaluation checks:

- Geometry module 58601 is extracted and executed: display 1920x1080 with 25 px menu bar, mac, bottom edge -> `{x:704, y:426, w:512, h:614}` (centered, flush with work-area bottom 1040); left edge -> `{x:0,y:25,w:490,h:1015}`; Windows -> bottom edge at 1038 (2 px short).
- Scaler `E` is extracted and executed on dB sequence `[-40,-30,-20,-50,-30]` -> `[0, 0.5, 1, 0, 1]`, floor `-50`; clamp at `-60` confirmed.
- Window options (18 individual strings), channel names in both main and renderer (18 channels), 400 ms/150 ms intervals, alpha byte index 3, threshold 127, setShape cap 128, CSS pill sizes, wobble keyframes, spinner geometry, timers.

Optional visual check: open `prototypes/pill-waveform.html` in Chromium; choose "ptt", synthetic speech, mic active - bars should rise center-first (weights 0.58..0.99), shimmer with the 1 s phase-shifted wobble and fall back to 2 px dots in about half a second when switching to "processing" (spinner appears).
