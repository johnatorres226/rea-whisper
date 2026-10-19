# 01 - Audio capture, encoding and packetization (the subject app 1.6.1102)

Scope: microphone -> PCM/Opus packets, up to the point where packets are handed to the network transport.
Citations are `path:line` relative to `work/pretty/`. `hub` = `renderer/hub/index.js`, `main` = `main/index.js`.
Line numbers refer to the prettier-formatted files and were re-checked by `tools/audio-validate.mjs`.

## 1. Overview

Dictation audio is captured in the **hub renderer** (the "Flow Hub" BrowserWindow). That window is created with `show: false`
(`main/index.js:342464-342475`, assigned to `hubWindow` at `main/index.js:170612`), so in practice it acts as a hidden
audio host. The renderer opens `getUserMedia` at 16 kHz mono with all DSP off, feeds it through an `AudioWorklet`
that cuts the stream into 640-sample (40 ms) Float32 blocks, converts each block to Int16, computes a dBFS level for it,
and sends it to the main process on the IPC channel `dictation:audioChunk`. If enabled, a WebCodecs `AudioEncoder`
(Opus) runs in the same renderer, in parallel, and also sends 20 ms Opus packets on the same channel. Main keeps
both packet lists, picks one (`useOpus`), turns the level into a 0..1 value for the pill, and passes each packet,
unbatched, to the gRPC client as one `bytes` item of `Payload.audio_packets`.

```
 main process                                  hub renderer (hidden "Flow Hub")
 ------------                                  ---------------------------------
 hotkey -> start dictation
   decide useOpus (flags)
   send "dictation:audioStart"  ------------>  startRecording():
        {useOpus, transcriptionEntityUuid}       getUserMedia({audio:{deviceId:{exact},sampleRate:16000,
                                                   channelCount:1,AEC/NS/AGC off}})
                                                 MediaStreamSource -> AudioWorkletNode("recorder-processor")
                                                       |  (AudioContext{sampleRate:16000, latencyHint:"interactive"},
                                                       |   pre-built at app start and kept alive)
                                                 worklet: 128-sample quanta -> 640-sample Float32 chunks (40 ms)
                                                       |  port.postMessage({0: Float32Array})
                                                 handleRecorderWorkletMessage(e):
                                                   all-zero? -> silence logic (drop before first real audio)
                                                   int16 = clamp*32767/32768
                                                   vol = 20*log10(rms(float chunk)+1e-10)       [dBFS]
                                                   (opus on) AudioEncoder.encode(s16 AudioData) ----+
 "dictation:audioChunk" <---- ipcRenderer.send  {packet:ArrayBuffer(1280 B Int16), index, volume,     |
   Ln(): index/gap check                          duration:40, encoding:"wav", transcriptionEntityUuid}|
   push packet+volume into                                                                              |
   wavAudioPackets / opusAudioPackets  <------- {packet:ArrayBuffer(opus), index, volume,duration:20,  <+
   level meter (150 ms timer) ------> "status:audioLevel" -> statusWindow (pill)  encoding:"opus"}
   Sn(Infinity) -> gRPC sendAudioPackets -> Payload.audio_packets (one bytes item per packet)
 "dictation:audioStop" ------------------->  worklet "stop": flush partial chunk, post "recorderWorklet:done"
 <-- "dictation:recordingDone" (timing info)  Opus flush (<=1 s), close stream
```

## 2. Findings

### 2.1 Which process captures, and constraints (Q1)

- Capture is done in the hub renderer by a static class (referred to here as MediaManager, minified `mf`) in `renderer/hub/index.js`. The start trigger is the main-to-renderer message `dictation:audioStart` (`hub:3277`, handler `hub:34257-34263`), carrying `{useOpus, transcriptionEntityUuid}`; main sends it from `main/index.js:235038-235041` (skipped when the action source is BLE, `main/index.js:235037`). Stop is `dictation:audioStop` (`hub:34264`); `dictation:audioClose` just runs graph cleanup.
- Constraints are a static object (`hub:34129-34137`): `echoCancellation:false, noiseSuppression:false, autoGainControl:false, sampleRate:16000, channelCount:1`. `deviceId` is added later by `selectAudioDevice` as `{exact: selectedDeviceId}` (`hub:38139-38144`). Exact (not ideal) means an unplugged device yields `OverconstrainedError`/`NotFound`, handled below.
- Device selection (`resolveAudioDevice`, `hub:38073-38115`), in priority order: (a) the Jabra "override" device if present; (b) the user's `overrideAudioDeviceId` if it is currently listed and is a "virtual" device; (c) the first entry of the user's `rankedAudioDevices` list that is currently connected, allowed by the Jabra not-worn filter, and (in clamshell mode) not the built-in mic; a built-in mic that was skipped only for clamshell is the second-tier fallback; (d) otherwise the sentinel device id `"default"` (`hub:14487` defines `C = "default"`), except when the OS default is an off-head Jabra headset, then any other non-virtual device. The list is refreshed on `navigator.mediaDevices.ondevicechange` (`handleDeviceChange`, `hub:38146`; listener `hub:38228`) and after every stop; the list is also sent to main as `UpdateAudioDevices`.
- Failure handling in `setupMediaStream` (`hub:36865-37180`): an 8 s watchdog (`hub:36961`) raises a `MicAccessTimeout` notification but keeps waiting; on error (other than NotAllowed/Abort) it retries `getUserMedia` after 250 ms then 750 ms (`hub:36856`), re-enumerating devices first when the error was NotFound. A `getUserMedia` that is aborted by a quick stop is "orphaned" and its promise is reused for up to 10 s if the constraints are identical (`hub:37037`, `Vg`), otherwise its tracks are stopped. Errors are reported to main as `GetUserMediaError` and mapped to notifications (NotAllowed -> permission, NotFound -> mic not found, Overconstrained -> device unavailable, NotReadable, other).
- If the active device vanishes during a recording, the dictation is stopped and a `MicDisconnected` notification is requested (`hub:38185`).
- Other `getUserMedia({audio:true})` calls (`hub:66243`, `hub:169587`) are permission probes whose tracks are stopped immediately. `hub:170774-170785` is a separate mic-test/extension path that builds its own `recorder-processor` node and emits `media:extensionAudioChunk`; it is not the dictation path.

### 2.2 AudioWorklet pipeline (Q2)

- One `AudioContext({sampleRate: 16000, latencyHint: "interactive"})` is built in `buildAndPublishAudioGraph` (`hub:37656`, latencyHint constant `hub:33890`). Because the context itself is 16 kHz, **Chromium does the resampling** from the device rate to 16 kHz; the app code contains no resampler. The worklet node (`"recorder-processor"`, 1 input, 1 output) is connected to `destination` (`hub:37683`), optionally to a silent sink on Windows (feature flag `windows-audio-silent-sink`).
- The worklet module is a separate file loaded with `audioWorklet.addModule("../dist/recorderWorklet.js")` (`hub:34002`, `hub:37539-37560`, 3 attempts with doubling backoff). Source: `work/app/.webpack/renderer/dist/recorderWorklet.js` (1650 bytes, not in `pretty/`).
- Worklet behavior (verified by executing the file, see Validation): chunk size 640 samples, render quantum 128, one Float32 buffer per input. On `"start"` the write index resets and recording begins; `process()` copies channel 0 of each 128-sample quantum into the buffer, and posts the buffer when it is full (5 quanta = exactly 640). Posted message is an object keyed by input index: `{0: Float32Array(640)}` (a copy via `slice`). On `"stop"` it posts whatever is buffered (a **partial** chunk, 1..639 samples, possible), then the string `"recorderWorklet:done"`, then clears its buffer. Strings starting with `"log"` are forwarded to the logger.
- Main-thread conversion (`cf`, `hub:34003-34010`): clamp to [-1,1], then `x<0 ? x*32768 : x*32767`, stored in an `Int16Array` (little-endian on all supported platforms). The `ArrayBuffer` of that array is the "wav" packet: **raw 16-bit mono 16 kHz PCM, no header**, 1280 bytes for a full chunk. (A WAV header is added only by main for the HTTP fallback, `main/index.js:229110-229118`.)

### 2.3 Transport to main and packetization (Q3)

- Every chunk is sent with `window.electron.ipc.send` -> `ipcRenderer.send("dictation:audioChunk", payload)` (`hub:10223-10250`, `renderer/hub/preload.js:3110`). No transfer list is used; Electron structured-clones the ArrayBuffer. Payload shape (`hub:38046-38051`): `{packet: ArrayBuffer, index: int, volume: dBFS number, duration: ms, encoding: "wav"|"opus", transcriptionEntityUuid, synthetic?: true}`.
- WAV stream: 1 packet per worklet chunk, `duration: 40` (`tf`, `hub:33991`), `index` = running counter reset to 0 per recording (`hub:34632`).
- Opus stream (only if main said `useOpus` and `AudioEncoder` exists and the config was probed as supported): a WebCodecs `AudioEncoder` is configured with `{codec:"opus", sampleRate:16000, numberOfChannels:1, bitrate:64000}` (`af`, `hub:33994-33998`; `initOpusEncoder`, `hub:38279-38322`). No `application`, `frameDuration`, `complexity`, or `format` fields are set, so Chromium defaults apply (VoIP-style Opus, 20 ms frames; the code itself labels outputs `duration: 20`, `hub:38311`). Each 640-sample chunk is wrapped in an `AudioData{format:"s16", numberOfFrames:640, timestamp: wavChunkIndex*40*1000 us}` and encoded (`hub:38013-38024`), producing about two 20 ms packets per chunk. Output callback sends `{packet, index: opusChunkIndex, volume: volumes[opusIndex] ?? 0, duration: 20, encoding:"opus"}` (`hub:38300-38318`). Raw Opus packets (no Ogg), one per message.
- Per-Opus-packet volume: for each chunk the Float32 samples are split into two halves and `dBFS(half)` is pushed to a shared list (`hub:38003-38011`), so Opus packet *i* gets the level of its own 10 ms-granular half (index-aligned, assuming 1 chunk -> 2 packets).
- Synthetic lead-in: when the first chunk is processed and an Opus encoder exists, the renderer first emits **two** all-zero 640-sample "wav" packets (`volume:-200`, `synthetic:true`) and advances the WAV index by 2 (`hub:38028-38042`). Real WAV audio therefore starts at index 2. Purpose is not stated in code (inferred: keep WAV/Opus indices and durations aligned for Opus encoder priming/delay; unverified).
- On stop: `"stop"` is posted to the worklet; on `"recorderWorklet:done"` the Opus encoder is flushed (1 s timeout) and closed, then `dictation:recordingDone` is sent with timing info (`hub:37798-37830`, `finalizeOpusEncoding` `hub:38354-38395`). If Opus was not used, `recordingDone` is sent immediately. `waitForRecordingToStop` gives up after 2 s (`hub:37205-37235`).
- Main-side intake (`Ln`, `main/index.js:230346-230560`):
  - Testing status: packet is ignored, only the level is forwarded (see 2.4).
  - Packets whose `transcriptionEntityUuid` differs from the current dictation are dropped as stale.
  - Index continuity per encoding: expected = last+1; a gap increments `droppedChunkCount` (and `startupDroppedChunkCount` if the gap starts at index 0, else `midSessionDroppedChunkCount`); out-of-order logs an error; this feeds the telemetry attribute `dictation.audio_chunks_dropped` (`main/index.js:229153`, counter at `233840`).
  - Packets arriving after the dictation left the listening states are dropped (WAV, non-synthetic ones are counted as `dictation.capture.after_commit`).
  - Packet and volume are appended to `wavAudioPackets` or `opusAudioPackets`; `packetDuration` and `encoding` are recorded.
  - If `useOpus` is on but 2000 ms of WAV have arrived with zero Opus packets, main flips `useOpus=false` (`main/index.js:230507-230520`, metric `dictation.opus_encoder_fell_back`). Packets of the non-selected encoding are stored but not sent (`230521`).
  - Sending: if the gRPC client is connected, `Sn(Infinity)` returns **all not-yet-sent packets** of the selected stream (`main/index.js:229087-229109`, `230525`) and `sendAudioPackets` queues them (`main/index.js:200795-200820`); each packet becomes one `Uint8Array` item of `Payload.audio_packets` (`main/index.js:201753-201762`). In steady state that is one packet (WAV) or about two (Opus) per IPC message; the queue worker may coalesce more if it lags. There is no fixed "packets per send"; the gRPC send batch is whatever has accumulated. The HTTP path instead slices `basetenChunkSizeSeconds = 28` s of packets (`main/index.js:231353`, module-local constant; `Math.ceil(28000/packetDuration)` = 700 WAV or 1400 Opus packets).
  - Opus enablement is decided in main at dictation start: `UseOpus` flag (or the `opus-eu-asia-experiment-v2` variant == Control), AND the renderer's probe result (`dictation:opusEncoderSupport`, default true until probed, `main/index.js:232939-232955`), AND not voice-actions-realtime (`main/index.js:235014-235022`). On a gRPC retry the encoding can be switched per retry params (`main/index.js:202130-202134`).
- `opusEncoder.worker.js` / `incrementalOpusEncoder.worker.js` are **not** in the dictation path. The first is spawned by an Opus-support/offline encoding helper (`main/index.js:300305`), the second by the meeting recorder (`main/index.js:269069`). Not analysed further here.

### 2.4 Audio level metering (Q4)

Computation (all numbers verified):

1. Renderer, per 40 ms WAV chunk: `volume = 20 * log10( sqrt(mean(x^2)) + 1e-10 )` over the **Float32 samples in [-1,1]** (not the Int16), i.e. dBFS RMS, with a floor of -200 dB for pure silence (`hub:7665-7666`, call site `hub:38046`; main has an identical copy at `main/index.js:156705-156706`). Value is shipped in the `volume` field of each `dictation:audioChunk` message. Synthetic lead-in packets carry -200.
2. Main, per WAV packet only (Opus packets do not drive the meter), `Ln` computes `level = scaler.scale(volume)` (`main/index.js:230471-230473`). The scaler is created by `createScaler()` with defaults `minFloor=-60`, `span=20` (`main/index.js:156727-156741`, instance `229073`). It keeps a **running floor** that starts at 0 and is lowered, never raised, to `max(-60, volume)` whenever a quieter chunk arrives; output = `clamp((volume - floor)/20, 0, 1)`. The floor is only reset in test-mode entry (`main/index.js:230660`), so it persists across dictations for the app lifetime.
3. Main buffers the per-chunk levels in a list and a `setInterval` at **150 ms** (`main/index.js:230476-230497`) sends the arithmetic mean of the levels since the last tick (about 3-4 chunks), then clears the list. The interval is created lazily on the first chunk and cleared by `Dn()` (`230343`, on test mode entry).
4. Target and channel: `ipcMain` -> `webContents.send("status:audioLevel", number)` (channel enum `main/index.js:145643`; send helper `main/index.js:246770-246790`). Primary target is `nB()` = the **status (pill) window**, `RA.statusWindow` (`main/index.js:234100-234105`). Extra copies go to the floating window if the mic state is "paused" (`getMicState()==="paused"`) and to the context-menu window when the instruct chat is open (`main/index.js:230484-230493`). The pill renderer subscribes at `renderer/status/index.js:13157` (the payload is a bare number in 0..1; smoothing happens with `requestAnimationFrame` there).
5. Test mode (mic test, status `Testing`): no scaler or timer; each packet is immediately mapped with `clamp((volume + 50)/40, 0, 1)` (fixed -50..-10 dBFS window, `main/index.js:156742`) and sent to the **hub window** (`hubWindow`) as `status:audioLevel` (`main/index.js:230354-230357`).
6. The same volume list also feeds a speech-duration estimate: indices whose volume >= floor+3 dB, expanded by 2 packets each side (`On`, `main/index.js:229075-229086`), used at recording done.

### 2.5 Silence detection, warm-up, dropped chunks, max length (Q5)

- "Silence" means a worklet chunk whose Float32 samples are **all exactly 0.0** (`hub:37836`); it is a digital-silence/dead-mic detector, not a threshold detector.
- Leading digital silence (before the first non-zero chunk) is **discarded**: not indexed, not sent, not encoded (`hub:37838-37846`, and `if (e) return` after the counters at `hub:37948`). Feature flag `DictationSilentStartNotice` only changes whether those chunks are *counted* toward the warning (`hub:37493-37500`). `wavChunkIndex` therefore starts at the first real audio.
- After the first non-zero chunk, all-zero chunks are sent like any other. A counter tracks consecutive zero chunks: log warnings at 520, 1000, 2000 ms (`hub:37858`); at **125 consecutive chunks (5 s)** (`hub:34181`) it logs "Audio silence bug detected", requests the `NoAudioDuringDictation` notification, sends `status:micSilence = true` (`hub:37909`, enum `main/index.js:145659`), and arms a 1 s check that `AudioContext.currentTime` is advancing; at **375 chunks (15 s)** (`hub:34182`) it escalates to `NoAudioDuringDictationEscalated`. Both clear (with `micSilence=false`) when non-zero audio returns.
- Silent-start mic reopen (flag `DictationSilentStartMicReopen`, default off: `main/index.js:324215-324216`): if the 125-chunk threshold is hit *before any real audio* and no drain is in progress, `reopenDictationMic` (`hub:37502-37540`) stops the current tracks, calls `getUserMedia` again with the same constraints (3 s timeout), and, if the same recording is still active, connects the new stream to the same worklet node and swaps `sourceNode`. Result is stored as `timingInfo.silentStartMicReopen` = "reopened" | "failed", and main emits `dictation.silent_start.mic_reopen` (`main/index.js:233816`, called with timing data at `229405-229413`). It can happen at most once per recording (constraints are nulled).
- Main watchdog: if 5 s after dictation start no WAV packet exists, the dictation is stopped with `NoAudioDuringDictationError` (`main/index.js:230561-230571`). Span `dictation.audio_acquire` starts when `audioStart` is sent (`main/index.js:235031-235034`) and ends on the first packet of the stream (`main/index.js:230464`); `dictation.audio_silence_detected` is emitted as a counter (`main/index.js:233836-233841`) and as a transaction attribute computed as `0 === <second arg>` of the attribute builder `zn` (`main/index.js:229152-229154`); the meaning of that argument (probably the packet/audio count of the dictation) was not traced.
- Max length: when elapsed time since start exceeds **1,260,000 ms (21 min)** while still Listening, main force-stops (`forceStopped = "max_duration"`) and shows `DictationMaxDurationReached` (`main/index.js:230573-230606`). After a stop request, a grace of `rn` = 15+12+5+3 = 35 s (`main/index.js:143312-143316`) protects the stop pipeline. The proto limit of 18000 `audio_packets` items equals 12 min of 40 ms WAV packets or 6 min of 20 ms Opus packets, so the 21-minute cap is not expressible by that limit alone (see open questions).
- AudioContext health: on `suspended`/`closed` during recording the renderer attempts `resume()` and logs severe (`hub:37745-37770`); if no running context/worklet at start, a 300 ms resume grace is tried and then a background rebuild with `dictation:audioContextRecoveryStarted` (main dismisses the attempt, `main/index.js:230729-230738`; `hub:34520-34600`). The context is rebuilt after a stop if more than 5 min passed since the last rebuild and the recording was over 3 s, or if mic+worklet setup exceeded 1 s (`condReloadAudioCxOnStop`, `hub:38053-38060`, `34171-34172`).

### 2.6 Pre-roll and keeping the mic warm (Q6)

- **No audio pre-roll exists.** Nothing records before `dictation:audioStart`; the first sample is whatever the worklet receives after `port.postMessage("start")` (`hub:34640`). No ring buffer was found.
- What *is* warm: the `AudioContext` and the worklet node are created at `Initialize` (`hub:34291-34305`: `initialize` -> `updateDevicesList` -> `reloadAudioContext`) and kept running between dictations, so only `getUserMedia` + `createMediaStreamSource` are paid at hotkey time. The microphone stream itself is **opened per dictation and closed on stop** (`setupMediaStream` at start; `cleanupMediaStream` stops all tracks, `hub:37185-37246`). `cleanupMediaStream` also opens a throwaway `getUserMedia` (3 s timeout) and stops it first, which the log calls an "AirPods workaround".
- Main also calls `pauseMicForDictation()` (`main/index.js:235026`) before sending `audioStart`. It is a method of the meeting-notetaker session (`main/index.js:263381`): if a meeting is active it sets mic state to "paused" and tells the hub to stop the meeting mic capture, so dictation has the mic. That paused state is why the floating window also receives level updates (2.4).
- Latency telemetry: `mediaStreamSetup`, `workletSetup`, `firstAudioChunkLatency`, `timeToReceiveLastAudioChunk`, `recordingFinish` are recorded (`hub:34632-34640`, `38000-38010`) and returned in `recordingDone`.

## 3. Pseudocode

### 3.1 Capture -> encode -> packetize (renderer side)

```
CONST SR=16000; CHUNK=640 (40 ms); OPUS_CFG={codec:"opus",sampleRate:16000,numberOfChannels:1,bitrate:64000}

on_app_init():                      # always, before any dictation
    devices = enumerateDevices(audioinput); selectedDeviceId = rank_resolve(devices)  # see 2.1
    ctx  = AudioContext(sampleRate=SR, latencyHint="interactive"); load module recorderWorklet.js
    node = AudioWorkletNode(ctx,"recorder-processor",inputs=1,outputs=1); node.connect(ctx.destination)

on audioStart{useOpus, uuid}:
    if ctx not running: resume (300 ms grace) else rebuild graph & abort this attempt
    index=0; opusIndex=0; volumes=[]; firstRealAudio=false; silentRun=0
    stream = getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,
                                  sampleRate:SR,channelCount:1,deviceId:{exact:selectedDeviceId}}})
             # on error (not NotAllowed/Abort): wait 250ms retry, wait 750ms retry, else notify+MicAcquisitionFailed
    src = ctx.createMediaStreamSource(stream); src.connect(node)
    if useOpus and AudioEncoder supported: enc = AudioEncoder(OPUS_CFG, output=emit_opus)
    node.port.post("start"); send(RecordingStarted)

worklet(process, per 128-sample quantum, channel 0):
    buf[w..w+128] = input; w += 128
    if w + 128 > 640 before copying: flush(w)      # never triggers for 128 | 640
    if w >= 640: post({0: copy(buf[0..w])}); w = 0
on "stop": if w>0: post({0: copy(buf[0..w])}); post("recorderWorklet:done"); w=0

on worklet message m (Float32Array x = m[0]):
    if all(x[i]==0):
        if not firstRealAudio: return                      # leading digital silence is dropped
        silentRun++ ; (5 s -> notify + maybe mic reopen if before audio; 15 s -> escalate)
    else:
        firstRealAudio = true; if silentRun>0: clear notifications; silentRun=0
    pcm = Int16Array(len(x)); pcm[i] = x[i]<0 ? clamp(x[i],-1,1)*32768 : clamp(x[i],-1,1)*32767
    vol = 20*log10( sqrt(sum(x^2)/len(x)) + 1e-10 )         # dBFS
    if enc:
        volumes.push(dBFS(x[0:len/2])); volumes.push(dBFS(x[len/2:]))
        enc.encode(AudioData{s16, SR, frames=len(pcm), channels=1, timestamp=index*40*1000})
        if index==0: 2x send({packet:640 zero int16, index:index++, volume:-200, duration:40,
                              encoding:"wav", synthetic:true})
    send("dictation:audioChunk", {packet:pcm.buffer, index:index, volume:vol, duration:40,
                                  encoding:"wav", transcriptionEntityUuid:uuid}); index++

emit_opus(chunk):  send("dictation:audioChunk",{packet:bytes(chunk), index:opusIndex++,
                        volume: volumes[opusIndex] ?? 0, duration:20, encoding:"opus", uuid})

on audioStop: post "stop" to worklet; await "done"; if enc: flush(<=1s); close; send(RecordingDone, timings)
              stop all tracks (+ throwaway getUserMedia), maybe rebuild AudioContext; re-enumerate devices
```

### 3.2 Main-side intake and level meter

```
state: wav={packets,volumes,packetDuration}, opus={...}; last index per encoding; floor=0; pending=[]; timer=null
const MIN_FLOOR=-60, SPAN=20

scale(v): if v < floor: floor = max(MIN_FLOOR, v)
          return clamp((v - floor)/SPAN, 0, 1)

on "dictation:audioChunk" msg:
    if status==Testing: send(hubWindow,"status:audioLevel", clamp((msg.volume+50)/40,0,1)); return
    if msg.uuid != current: drop
    gap check: if msg.index > last+1: dropped += msg.index-last-1
    store packet & volume in list[msg.encoding]
    if msg.encoding=="wav":
        pending.push(scale(msg.volume))
        if timer==null: timer = every 150ms: if pending nonempty:
              m = mean(pending); send(statusWindow,"status:audioLevel", m)       # + floating/contextMenu windows in some states
              pending = []
    if useOpus and wavDuration>2000ms and opus.count==0: useOpus=false
    if msg.encoding == (useOpus?"opus":"wav"): grpc.sendAudioPackets(all unsent packets of that list)
watchdogs: 5 s without any wav packet -> stop (NoAudioDuringDictationError); >21 min -> force stop
```

## 4. Confidence and open questions

Verified directly in code (read + executed where noted): constraints; 16 kHz context; 640-sample/128-quantum worklet (executed); Int16 conversion; dBFS formula; IPC channel and payload shape; 150 ms averaging timer; scaler constants (-60 floor, 20 dB span, floor persistence); `status:audioLevel` targets; Opus config object; 20 ms duration label; synthetic lead-in; silence thresholds (125/375 chunks); 5 s and 21 min main watchdogs; leading-silence drop; per-item `audio_packets` mapping.

Inferred / not verified:
- Opus frame size is 20 ms only by Chromium default and the code's own label; `AudioEncoder` could emit different sizes on other platforms. Opus "application" (voip/audio) is unspecified, so also platform default.
- Purpose of the two synthetic zero packets (guess: align indices/offset for encoder delay).
- Resampling quality: delegated to Chromium's `AudioContext(sampleRate:16000)`; the `sampleRate` constraint in `getUserMedia` is only a hint on most platforms.
- `status:audioLevel` receiver behavior (smoothing, bar mapping) is in `renderer/status/index.js` around line 13157-13175 and 19276; left to the GUI doc.
- The BLE capture path (no `audioStart`) feeds chunks from elsewhere and was not traced.
- The 18000-item proto limit vs the 21-minute cap: 21 min = 31500 WAV packets, which exceeds 18000, so the gRPC client must be splitting payloads or the limit is per message; the transport doc should confirm.
- `basetenChunkSizeSeconds` (28) is read from a module-local constant by position (`main/index.js:231353`), mapped via the export table at `230904`; high but not machine-proven.
- Feature flags are default-off in local defaults (`main/index.js:324215`); real values come from the remote flag service.

## 5. Validation

Run everything with `node tools/audio-validate.mjs` (no dependencies; exits 1 on any failure). Result of the run recorded when writing this document: **30 checks, ALL PASSED**. Each check asserts specific text at the cited line, or executes code, so it fails if the line moves or the claim is wrong.

| Claim | Check |
|---|---|
| getUserMedia constraints (2.1) | script asserts `echoCancellation: !1 ... noiseSuppression: !1 ... autoGainControl: !1 ... sampleRate: nf ... channelCount: 1` in `hub:34129-34137`; also `nf = 16e3` at `hub:33992` |
| exact deviceId | `hub:38141` contains `deviceId: { exact: mf.selectedDeviceId` |
| 40 ms chunks / 640 samples | `tf = 40` at `hub:33991`; the script loads the real `recorderWorklet.js` into a `vm` with a mock `AudioWorkletProcessor`, feeds 13 quanta of 128 samples and asserts the first two posted arrays have length 640 and `registerProcessor` name is `recorder-processor` |
| partial flush on stop | same harness: after `"stop"`, last message is `"recorderWorklet:done"` and the preceding chunk has 1664-1280 = 384 samples |
| Opus config | `bitrate: 64e3` at `hub:33997` and `duration: 20` at `hub:38311` |
| dBFS volume | `hub:7665-7666`; plus numeric checks in the script (full-scale = 0 dB, silence = -200 dB) |
| scaler | regex over `main/index.js:156727-156742` for `-60`, `t = 20`, `r < n && (n = Math.max(e, r))`, `(r - n) / t`; numeric: -50 dB -> 0.5 after floor -60, -30 dB -> 1, -200 first call -> 0 |
| 150 ms mean timer, channel | `main/index.js:230479` and `230497`; `status:audioLevel` at `main/index.js:145643` |
| test-mode mapping | `(e - -50) / 40` at `main/index.js:156742` |
| thresholds | `= 125` and `= 375` at `hub:34181-34182`; `g > 126e4` near `main/index.js:230573`; `5e3` near `230561` |
| synthetic packets | `hub:38025-38042` match `Int16Array(640).fill(0)` ... `volume: -200` ... `synthetic: !0` |
| leading silence dropped | `hub:37838-37846` match `before first real audio - discarding ... countsSilenceBeforeFirstAudio ) return` |
| packet-per-item mapping | `main/index.js:201757` contains `items: e.packets.map((e) => new Uint8Array(e))` |

Extra manual one-liners (run from `work/pretty`):
- `grep -n '"dictation:audioChunk"' renderer/hub/index.js` -> one match (`3278`).
- `grep -nF 'bitrate: 64e3' renderer/hub/index.js` -> `33997`. If this changes, the Opus claim is wrong.
- `grep -n 'dictation.audio_chunks_dropped' main/index.js` -> includes `229147` (telemetry name used in this doc).
