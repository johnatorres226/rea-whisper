# 00 - System overview: voice → server ASR + LLM → text in the focused app

Subject: a commercial desktop voice-dictation app, version 1.6.1102, macOS build (x86_64). It is called "the subject app" throughout. This overview ties together the four deep-dive documents:

| # | Document | Covers |
|---|---|---|
| 01 | [Audio capture](01-audio-capture.md) | Mic, AudioWorklet, PCM/Opus packets, level meter, silence |
| 02 | Dictation transport *(local only, not yet published, see "Status")* | gRPC bidi session, commit/heartbeat, recovery, result selection |
| 03 | [Trigger, context, delivery](03-trigger-context-delivery.md) | Native helper, hotkeys, accessibility context, paste and verify |
| 04 | [Status pill GUI](04-status-pill-gui.md) | Overlay window, click-through, states, waveform |
| - | [Wire schema](proto/README.md) | Reconstructed `.proto`, validated |

Each document gives `path:line` citations into the prettier-formatted bundle (`work/pretty/…`, rebuilt with `tools/setup-workspace.sh`). Each also has pseudocode and a validation section backed by a script. `tools/validate-all.sh` runs every check.

## 1. Process architecture

```
 ┌──────────────────────── Electron app ────────────────────────────────────────────┐
 │                                                                                   │
 │  MAIN PROCESS  (Node)  ── single source of truth: Zustand store, mirrored to      │
 │   • dictation controller / state machine        every window via zubridge IPC     │
 │   • gRPC client  (@grpc/grpc-js + protobuf-ts)  ───────── TLS:443 ──► ASR+LLM svc │
 │   • helper supervisor (spawn, stdio framing, keepalive)                           │
 │   • level-meter scaler (dB → 0..1, 150 ms averaging)                              │
 │   • sqlite (history, dictionary; umzug migrations)                                │
 │        ▲ dictation:audioChunk          │ status:audioLevel / status:* / store     │
 │        │                               ▼                                          │
 │  HUB RENDERER (hidden window)     STATUS RENDERER ("pill", transparent panel)     │
 │   • getUserMedia 16 kHz mono       • React; 10-bar CSS waveform                   │
 │   • AudioWorklet → 40 ms Float32   • states: resting/ready/ptt/locked/processing… │
 │   • RMS dB per chunk               • click-through via alpha hit-test (main side) │
 │   • WAV (Int16) or WebCodecs Opus                                                 │
 └───────▲───────────────────────────────────────────────────────────────────────────┘
         │ stdin: requests   fd3: events/responses   (JSON, '+'-escaped, '|'-terminated)
 ┌───────┴──────── Native helper (Swift, separate process) ──────────┐
 │ • CGEventTap keyboard listener (+ IOHID for Caps Lock)            │
 │ • Accessibility (AX) reader: focused app, textbox before/sel/after│
 │   nearby texts, AX tree as pseudo-HTML                            │
 │ • Paste engine: save clipboard → write text/HTML → synth Cmd+V →  │
 │   restore after 500 ms; post-paste verification for 60 s         │
 └──────────────────────────────────▲────────────────────────────────┘
                                    │ AX / CGEvent / NSPasteboard
                             focused target app
```

Three facts drive the whole design:

1. **The heavy lifting is server-side.** The client does no ASR and no LLM formatting. It streams audio, streams context, and receives formatted text. The schema shows this: `Progress{transcriber_finished, formatter_finished, post_processing_finished}`, `ResponseTime{external_asr_time, external_llm_time}`, and the `Origin` enum lists four ASR engines plus a `MIXTURE` (candidate-beam selection) mode.
2. **The OS-facing work runs in a native helper.** Electron cannot install a keyboard event tap, read the accessibility tree, or post synthetic keystrokes reliably, so a small Swift process does all three. It speaks a JSON-schema-defined protocol, and the same schema generates TS, Swift and C# models.
3. **The main process holds all state.** Renderers are views. The pill never computes dictation state. It renders store snapshots and level numbers pushed from main.

## 2. One dictation, end to end

The timeline below is for push-to-talk. Hands-free (double-press, or fn+space) differs only in how "stop" is detected.

| t | Actor | What happens | Doc |
|---|---|---|---|
| 0 | helper | CGEventTap sees `fn` down → `KeypressEvent` to main over fd3 | 03 §3 |
| 0+ | main | Chord matcher: ptt pressed → dictation `start`; asks helper for `DictationStart` (begin context capture); pill state → `active_ptt` | 03, 04 |
| ~0 | hub | `dictation:audioStart` → `getUserMedia` (AEC/NS/AGC **off**, 16 kHz mono) → worklet emits 640-sample (40 ms) chunks | 01 §2.1-2.2 |
| ~0 | main | Opens the gRPC `TranscribeStream`. First `Request` = `init` (metadata, preferences: language, dictionary, replacements, style) plus any audio already captured | 02 §3.2 |
| every 40 ms | hub → main | `dictation:audioChunk {packet, index, volume(dB), duration, encoding}`. Leading all-zero chunks are dropped | 01 §2.3, 2.5 |
| every chunk | main → server | Sends all unsent packets as `payload.audio_packets` with `commit=FALSE`. No batching timer; packets queue while a write is in flight | 02 §3.2 |
| every 150 ms | main → pill | `status:audioLevel` = mean of `clamp((dB − floor)/20, 0, 1)` | 01 §2.4, 04 §4 |
| per frame | pill | `v ← smooth(v, level)`; bar `scaleY = max(1, 5v) × weight(i) × wobble(t, i)` | 04 §6 |
| as available | helper → main → server | Context pushes (`AppInfoUpdate`, `TextBoxInfo`, `AppContextUpdate`, …) become separate `context` Requests mid-stream | 03 §4, 02 §3.2 |
| server → main | heartbeat | `Heartbeat{audio_received_seconds, commit_ack}`. If it lags more than 2 s behind sent audio, a parallel HTTP race can start (feature-flagged) | 02 §3.4 |
| release | main | ptt released → recording stops → worklet flush → `onRecordingDone` sends `commit=TRUE`, half-closes the send side; pill → `processing` (spinner) | 02, 04 |
| after commit (latency not measured, static analysis only) | server → main | `State` updates (raw/formatted text, progress), then `Result{output.plaintext/html, status FORMATTED/RAW_TRANSCRIPT/ERROR}` | 02 §3.5 |
| | main | Client post-processing (personal and team replacements, snippets), then a final pick of `pasted_text ‖ llm_text ‖ asr_text` | 02 §3.5 |
| | main → helper | Paste request with text (and HTML for rich snippets) | 03 §5 |
| | helper | Save pasteboard → write → synthetic Cmd+V → restore at +500 ms. Watch the textbox for up to 60 s → `DictatedTextVerification` | 03 §5 |
| | pill | → `resting` (error state resets after 500 ms) | 04 §3 |

## 3. Orchestrator pseudocode (language-agnostic)

This file stitches the per-subsystem pseudocode together. Every constant comes from the deep-dive docs.

```
on KeyEvent(ev) from helper:                         # 03 §7.1
    action = chordMatcher.feed(ev)                   # ptt / lock / command / cancel
    if action == START:
        session = new Session(uuid())
        helper.send(DictationStart)                  # begin AX context capture
        store.set(status = LISTENING); pill.show(ACTIVE_PTT)
        hub.send("audioStart", deviceId)
        session.rpc = grpc.TranscribeStream(deadline = 23 min, keepalive = 4 s/2 s)
        session.rpc.write(Request{ init = buildInit(prefs) })
    if action == STOP:   hub.send("audioStop")       # flush partial chunk
    if action == CANCEL: session.abort(); pill.show(RESTING)

on AudioChunk(c) from hub:                           # 01 §3.2
    if c.isAllZero and not session.heardAudio: drop; return
    session.heardAudio = true
    session.pending.append(c.packet)
    meter.add(scaler.scale(c.volume))                # flushed to the pill every 150 ms
    if not session.writeInFlight:
        session.rpc.write(Request{ payload.audio_packets = drain(session.pending), commit = FALSE })

on ContextUpdate(piece) from helper:                 # 03 §7.2
    session.context.merge(piece truncated to 500 chars per textbox side)
    session.rpc.write(Request{ context = session.context })

on RecordingDone:                                    # 02 §4.2
    session.rpc.write(Request{ payload = drain(pending), commit = TRUE })
    session.rpc.closeSend()
    start timers: heartbeatSilence = 2 s, backstop = 20 min
    pill.show(PROCESSING)

on Response(r):                                      # 02 §4.3
    if r.heartbeat: session.lastBeat = now; maybeStartHttpRace(r.heartbeat)
    if r.state:     session.partial = r.state.formatted_text or r.state.raw_text
    if r.result:
        text = applyReplacements(r.result.output.plaintext)
        helper.request(Paste{ text, html = r.result.output.html })   # 03 §7.3
        history.save(session, r.result); pill.show(RESTING)

on Timeout/Error: tailRecoveryOverHttp(session.audio)  # 02 §4.4: ≤6 chunks of 28 s within 60 s
```

## 4. Reconciliations between the deep dives

These questions were raised in one document and answered in another. The answers are recorded here.

| Question (raised in) | Resolution |
|---|---|
| "What exactly is in an `audio_packets` item?" (02 open question) | Answered in 01. WAV mode sends **raw little-endian Int16 PCM with no header**: 1280 bytes = 640 samples = 40 ms at 16 kHz mono. Opus mode sends one WebCodecs `AudioEncoder` output chunk per item (20 ms, 64 kbps). `Init.metadata.audio_encoding` tells the server which. |
| "18 000-item max per `AudioPackets` vs a 21-minute recording, which would be 31 500 WAV packets" (01 open question) | The limit applies **per `Request` message**, not per stream. 02 shows each write drains only the *unsent* packets, so one message carries a few packets, or a backlog after a stall. The 23-minute stream deadline, not the item cap, bounds a session. |
| Default inference host (01/02) | Without a feature flag, the client uses a fixed default host. A remote "dictation URL" file is consulted only under a test flag, and its answer must be in a 3-entry allowlist. |
| Where start/stop sounds play (04) | The hidden hub window plays them, not the pill. The pill plays only the lock, paste and toast sounds. |

## 5. Methodology and terminology

The work follows the standard reverse-engineering stages. Each stage produces an artifact that someone else can rerun.

| Stage | Term | What was done here |
|---|---|---|
| Acquisition | *artifact extraction* | Unpacked the Electron ASAR archive. Inventoried the native helper and node addons. |
| Readability | *beautification / normalization* (deobfuscation-lite) | Reformatted minified webpack output with prettier. Names stay minified, so citations use line numbers. |
| Static analysis | *AST analysis, data-flow and cross-reference tracing* | REA (`analyze_javascript_application`, `inspect_electron_fuses`), plus Babel-AST scripts in `tools/` and grep/sed with line ranges. Native helper: `nm`/`strings`/`otool`/`codesign` for imported APIs, symbols and entitlements. |
| Interface recovery | *protocol reconstruction* | Rebuilt the gRPC `.proto` from protobuf-ts reflection metadata, then cross-checked it against the serializers' wire tags, which are an independent code path. |
| Behavioral recovery | *lifting to a specification* | Described each subsystem as states, events, constants and **language-agnostic pseudocode**. This is the "intermediate representation" a reimplementation translates from. |
| Verification | *differential / mutation validation* | Each claim has a check that re-derives it from the shipped artifact. Mutation runs (changing a constant or field number) confirm that each check can fail. |
| Reimplementation | *clean-room re-implementation* (source-to-source translation from the spec, not from code) | `prototypes/pill-waveform.html` was written from the pseudocode alone, then rendered and measured. It produces 10 center-weighted bars that respond to level. |

**Dynamic analysis was not possible.** REA's fuse inspection shows `RunAsNode`, `EnableNodeCliInspectArguments` and `EnableNodeOptionsEnvironmentVariable` all **disabled**, and embedded ASAR integrity validation **enforced**. A debugger or inspector cannot be attached, and a modified bundle will not load. All findings are therefore static. Runtime ordering and timing come from code paths and constants, not from observed traces.

## 6. Status and open items

- **Doc 02 (transport) is written and its checks pass, but it is not committed.** Publishing it was blocked by a safety check. It is the only document that describes the vendor's backend infrastructure: third-party inference hostnames and model IDs, the auth-header layout, and the location of an embedded API key. The key's value is never reproduced. Whether, and in what redacted form, to publish it is the repository owner's call.
- Open questions are listed per document. The main ones:
  - whether the event tap swallows non-matching keys (03)
  - accessibility-walk limits (03)
  - the pill's exact vertical offset inside its 512×614 window (04)
  - server behavior when context is missing, and the minimal credentials it accepts (02)
  - remote feature-flag defaults, which are not in the bundle.
