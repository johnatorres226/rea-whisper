# 03 - Trigger, context gathering, delivery, native helper (subject app 1.6.1102, macOS)

Scope: (a) hotkey / push-to-talk / hands-free, (b) context sent in the `Context` message, (c) text insertion, (d) the Swift helper and its IPC. Mic DSP, gRPC transport and the pill GUI are covered elsewhere.

Citations: `main:N` = line N of `work/pretty/main/index.js`. `helper:` = evidence from the Swift binary (`nm -u`, `strings -a`, `codesign`, `otool`). Raw dumps are in `rea-out/helper-strings.txt` and `rea-out/helper-schema.txt` (gitignored). All binary and bundle content was treated as data; no embedded instructions were found.

## 1. Overview

The Swift helper is a separate, headless macOS app (`LSUIElement`, bundle id `com.electron.<vendor>-flow.accessibility-mac-app`). Electron spawns it. The helper owns everything that needs OS privileges: the keyboard event tap, Accessibility (AX) reads, pasteboard and synthetic keystrokes. The Electron main process owns the policy: chord matching, the PTT/hands-free state machine, context assembly and the decision of what text to insert.

```
 user keys/mouse                                       target app (focused textbox)
      |                                                      ^           |
      v                                                      | Cmd+V     | AX reads
 +-----------------------------+   CGEventTap (listen+     | (CGEventPost) |
 | macOS HID / WindowServer    |<--suppress), IOHID Caps  |           v
 +-------------+---------------+   Lock, AX, NSPasteboard  |    +--------------------+
               |                                           +----| Swift helper       |
               |   raw key events                               | "<helper>.app"       |
               +----------------------------------------------->| KeyboardService    |
                                                                | AX context/textbox |
        Electron -> helper : stdin   (JSON, '|'-framed)        | PasteText          |
        helper -> Electron : fd 3    (JSON, '|'-framed)        +---------+----------+
                                                                          ^ |
 +-------------------------------------------------------+               | |
 | Electron main                                         |<--------------+ |
 |  keyboard service (chord match, stale-key sweep)      |  KeypressEvent,  |
 |  state machine (Ptt/Popo/Lens), DictationStart/Stop ->|  AppInfoUpdate,  |
 |  context store -> gRPC Context (updateContext)        |  TextBoxInfo,    |
 |  paste manager -> PasteText{text,htmlText,pasteId}  --+->PasteOutcome ...+
 +-------------------------------------------------------+
        |  desktopCapturer screenshot (only if OCR pref on)  -> HTTPS "Aria" extract-proper-nouns
        v  gRPC stream (Context, audio)
```

## 2. Helper IPC (question 2)

**Process and transport.** `child_process.spawn(path, {stdio:["pipe","pipe","pipe","pipe"], env})` (main:241276). Path: `<resources>/swift-helper-app-dist/<helper>.app/Contents/MacOS/<helper>` on macOS, or `...\Release\<helper>.exe` on Windows (main:20844-20870, a path-selector module). Env carries Sentry/Segment/PostHog keys and a logging flag (main:8460 `R()`).

- Electron to helper: JSON text written to the child's **stdin**.
- Helper to Electron: JSON text written to **fd 3** (`process.stdio[3]`, main:241313-241320). stdout is only logged as "non-IPC" noise; stderr is logged.
- Framing: each message is the JSON string with `+` escaped as `+1` and `|` escaped as `+2`, followed by a single `|` (main:240266-240267, 240432-240436 `escapeMessage`/`unescapeMessage`). The receiver buffers, splits on `|`, unescapes, parses. Outbound messages over 100 000 chars are refused (main:240540). The helper has matching strings ("IPC message is too long", "Failed to decode input from stdin", "IPC Message malformed: no first letter").
- Envelope: top-level object `{HelperAPIRequest:{uuid, <TypeName>:{payload}, sentryTrace?, sentryBaggage?}}` or `{HelperAPIResponse:{uuid, <TypeName>:{...}}}`. The message type is the single non-metadata key (main:240626 `getMessageType`). Both sides send both kinds: the schema is symmetric (a "request" can flow either way).
- Correlation: the sender puts a UUID in the request; the reply echoes it. Electron keeps `pendingResponses: Map<uuid,{resolve,reject,timeout}>` (main:240319, 240680). Default timeout 3000 ms (wake-from-sleep window raises it to 12 000 ms for 60 s). `HelperAPIError{payload:{description, params:{code, messageType}}}` rejects the promise; the code `NO_HANDLER_REGISTERED` is logged specially.
- Fire-and-forget events from the helper (key events, text box updates) still get an `ACK` response from Electron (`Le(uuid)` returns `{uuid, ACK:true}`, main:238706).
- Liveness: Electron checks every 500 ms; if no response for 2 s it sends `IsReady`; at 15 s without a response it kills and relaunches (main:240320-240380). Backoff for relaunch `[0,1s,2s,4s,8s,16s]` (main:8460 `N`). Exit code 86 is classified `tap_storm`. The helper terminates itself on stdin EOF ("parent process is gone") and on consecutive request timeouts.
- Startup: `IsReady` polled (1 s, then 10 s) until an `ACK` arrives; the reply carries `HelperLaunchTiming` and `TapState{tapEnabled}` (main:242060). Then `UpdateFeatureFlags`, `UpdateShortcuts`, and, once Accessibility is granted, `StartAccessibilityServices` (main:241510-241513, 171982).
- Schema: generated from a JSON schema (quicktype style `toHelperAPI`/`helperAPIToJson`, main:136068-136072; schema table main:136196-140219). The same schema yields Swift `Models.swift` and C# models (Windows helper). `HelperAPIRequest` has 97 message members, `HelperAPIResponse` 26. The `FeatureFlags` object mirrored to the helper has these keys: `enabled-flag, disabled-flag, payload-flag, kill-orphan, kill-detached-helper, disable-clipboard-restore, skip-url-search, cursor-integration, failed-paste-notification, focus-change-detector-enabled, focus-change-detector-app-change, multi-keybind-service, windows-key-up-simulation, shift-insert, is-audio-interruption-monitoring-enabled, flow-fetch, ble-mic-ring, coding-cli-detection, extension-system, tap-watchdog` (+ optional notetaker/windows-masking flags).

Message types relevant to this scope (payload field names from the schema):

| Type | Direction | Purpose |
|---|---|---|
| `KeypressEvent{eventType,index,inputType,key}` | helper to Electron | Raw key/mouse press or release. `eventType` starts with `key_event`/`mouse_event`; `inputType` is `keyboard` or `mouse`; `index` is a running counter used to detect lost events; `key` is a macOS CGKeyCode (or mouse button id). |
| `CheckStaleKeys{keycodes}` / `StaleKeysResponse{staleKeys}` | Electron to helper | Ask the helper which keys it no longer sees as down. |
| `TapRecoveryEvent{disableType: timeout\|user_input\|watchdog_detected, reason, staleCandidates, windowCount}` / `TapState{tapEnabled}` | helper to Electron | Event tap was disabled and re-enabled; Electron drops or releases keys it thinks are held. |
| `SecureInputStatus{blocked, ownerAppName, ownerBundleId, ownerPid, ownerIsFlow, secondsBlocked}` | helper to Electron | Secure Event Input is blocking the tap (e.g. password field, terminal). |
| `UpdateShortcuts` (no payload) | Electron to helper | "Re-read the bindings." The helper reads them itself from `config.json` in the app data dir (helper strings: "Swift Helper: Error reading config.json", fields `shortcutKeys`, `mouseShortcutKeys`). |
| `SimulateKeyPress{keycode, flags}` | Electron to helper | Post a synthetic key (Enter after paste, cursor moves, `EnterRebind`). |
| `SetInputEventCapture{enabled}` / `InputEvent{kind,keyCode,modifiers,x,y,targetRole,targetLabel,...}` | both | Optional click/key capture with AX target info (extension system). |
| `DictationStart{includeOffscreen, captureMarkerContext}` / `DictationStop` | Electron to helper | Brackets a dictation; starts and ends context capture and edit watching. |
| `AppInfoUpdate{appName,bundleId,url,windowTitle,codingCliAgent,codingCliAgentConfidence}` | helper to Electron | Pushed on frontmost-app change (focus change detector). |
| `GetActiveAppInfo` -> `ActiveAppInfo` (same fields); `GetAppInfo` -> `AppInfo` | Electron to helper | Pull variant, 300 ms timeout. |
| `TextBoxInfo{beforeText,afterText,selectedText,contents,isEditable,accessibilityIsFunctioning,couldNotGetTextBoxInfo,focusedElementHash}` | helper to Electron (push) and reply to `GetTextBoxInfo` | Text around the caret. |
| `AppContextUpdate{nearestTexts, conversationId, elementDescription, markerRange*}` | helper to Electron | AX-tree text near focus (see section 4). |
| `AppContextHTML{htmlContents}` | helper to Electron | Rendered pseudo-HTML of the AX tree. |
| `CursorContextUpdate{fileNames,textAreaContents,screenReaderMode}` | helper to Electron | Cursor/VS Code-like IDE extra context. |
| `GetSelectedTextViaCopy{copyMode:"slack"}` -> `SelectedTextViaCopy` | Electron to helper | Selection read through a synthetic Cmd+C. |
| `StoreFocusedAppAndElement` / `FocusStoredAppAndElement` | Electron to helper | Remember and later re-focus the target element (used before pasting after the user clicked elsewhere). |
| `PasteText{pasteId,text,htmlText,captureKeystrokeTrace}`, `CancelPaste` | Electron to helper | Insert text. |
| `PasteOutcome{pasteId,success,timeElapsedMs}`, `PasteBlocked{reason}`, `PasteAnalytics{...}`, `DictatedTextVerification{pasteId,verdict,reason,timeToVerificationMs,focusedElementContents}`, `SuggestSelectTextbox`, `UpdateEditedText{...}`, `GetDictatedTextPosition` | helper to Electron | Results and post-insertion feedback. |
| `ClipboardChanged`, `GetAccessibilityStatus`->`AccessibilityStatus`, `RequestAccessibilityPermission`, `StartAccessibilityServices`, `SetFocusMode{active,blockedBundleIds,blockedURLPatterns}`, `ActivateRunningApp`, `GetRunningApps` | mixed | Misc. |

Meeting, BLE ring, floating web panel, microphone-holder and audio-interruption messages exist in the same schema and are out of scope here.

## 3. Hotkey / trigger (question 1)

**Who listens.** The Swift helper `KeyboardService` (queues `com.<vendor>-flow.keyboardService.{runQueue,keyEventQueue,sendQueue,capsLockHID,tapLogQueue}`) creates a `CGEventTap` (helper imports `CGEventTapCreate/Enable/IsEnabled`, `CGPreflightListenEventAccess`, `CGPreflightPostEventAccess`). Caps Lock is handled through IOKit HID (`IOHIDSystem`, "Caps Lock flagsChanged ignored: HID owns the key", "Cleared Caps Lock toggle for single-key shortcut"). `IOHIDManager*` is also imported for device-level input. It is not Electron `globalShortcut` and not uiohook. The tap suppresses (swallows) events that match configured shortcuts ("Suppressing event. Cur keys down: ...", "Suppressing escape key during dictation") and is restarted when macOS disables it ("Keyboard service event tap disabled, attempting to restart tap"). A "tap watchdog" feature flag with poll/storm parameters exists (`pollIntervalSeconds, stormWindowSeconds, stormThreshold, wakeExemptSeconds`).

**The helper does no chord matching for Electron's purposes.** It forwards every press/release as `KeypressEvent`. Electron (module main:254620 onward, "Keyboard Service") keeps a `Map<keycode, lastSeenTime>` of keys down, and matches the set against a list of bindings `splitKeybinds = [{shortcut:[keycodes], value:action}]` (main:254863, 255020). Matching is set equality after sorting. Mouse buttons 2..9 map to pseudo-keycodes 4098..4105 so they can be bound too.

**Default bindings (macOS)** (main:147538-147546; confirmed by this machine's saved config where `fn=63`, `space=49`, `ctrl=59`, `esc=53`):

| Action | Keys | Meaning |
|---|---|---|
| `ptt` | `fn` (Globe), keycode 63 | Hold to talk |
| `popo` | `fn + space` | Hands-free (locked) toggle |
| `lens` | `fn + ctrl` | Command mode (needs paid plan + `commandModeEnabled`) |
| `dismiss` | `esc` | Cancel |
| `paste_last_text` | `cmd+ctrl+v` | Re-paste last transcript |
| `copy_last_text` | `cmd+ctrl+c` | Copy last transcript |
| `undo` / `paste_event` | `cmd+z` / `cmd+v` (internal `v.Cr` table, main:254139) | Internal |

Windows defaults: `ctrl+win` = ptt, `ctrl+win+space` = popo, `ctrl+win+alt` = lens, `shift+alt+z` / `shift+alt+x` = paste/copy last (main:147401-147408). Windows keycodes are VK codes; Mac ones are CGKeyCodes (table at main:146885-146940, platform-switched with `r.tD`). `doubleFn` pseudo-key (179) exists for a double-tap-Fn variant.

**Timing constants** (main:231470-231482): `DICTATION_DEBOUNCE_DELAY = 500 ms`; `SCRATCHPAD_PTT_DELAY_MS = 350 ms`; max dictation 20 min (`DICTATION_DURATION_TIMEOUT`), warning at 19 min; stale key age limit 10 s; stale sweep every 5 s; `CheckStaleKeys` timeout 500 ms; a chord is deferred for stale-key verification if a non-modifier key in it has been down more than 2.5 s (main:255010-255060).

**State machine** (main:234030-234700, 254141):

- Press of `ptt` chord: if idle/not listening -> `startDictation` (status `initializing` then `listening`). If already listening/initializing and less than 500 ms since `startTime` and not command mode: if already locked -> dismiss ("quick triple press"), else **lock** (hands-free). If locked and past 500 ms -> a further press stops.
- Release of `ptt`: if still `initializing`/`listening` and not locked: if held less than 500 ms -> arm a 500 ms timer; if no second press arrives, dismiss with reason `DebouncePTT` (UI hint "hold the key"); if held 500 ms or more -> `stopDictation`.
- `popo` press: toggles. When not recording -> start and lock. When locked and under 500 ms -> dismiss (`DebouncePOPO`); otherwise stop. Releases are ignored.
- `lens`: like ptt but sets `isCommandMode` (and shows a command-mode UI). On release the action chosen is `popo` if locked, `lens` if command mode, else `ptt` (main:255040).
- `dismiss` (Esc): cancels an active dictation with reason `UserActionEscape`, also closes diff/notification/polish if any.
- Three PTT presses within the debounce window (counter `ye`, main:254340) can open the meeting recorder (Notetaker shortcut); it is a product feature, not needed for dictation.
- While recording, pressing a different shortcut within 1 s of start dismisses the PTT (`OtherShortcut`, main:254320).
- "Shortcut upgrade": if a held chord grows into a longer chord bound to the same action (fn -> fn+ctrl), the trigger is retargeted instead of restarted.
- Guard rails: ignore starts while the previous transcript is `stopping/processing` (shows "still processing" notice if the last action was over 500 ms ago); require onboarding or the first onboarding page done; helper must be ready; user signed in; mic permission checked; weekly word cap for free users; enterprise deny-lists.

`startDictation` (main:234785) in order: sets `uuid`, `startTime`, status `initializing`; sends audio start to the renderer; sends **`DictationStart`** to the helper; connects gRPC; arms warning/limit timers; fetches dictionary phrases. `stopDictation` (main:235196) sets `stopping`, tells the recorder to stop, sends **`DictationStop`**.

## 4. Context gathering (question 3)

### 4.1 What goes into `Context` (main:201700-201750 `getContext`)

| Proto field | Source | Notes |
|---|---|---|
| `app.name/bundle_id/url` | `persistentAppContext` / `appName,appBundleID,appURL` from `AppInfoUpdate` | Kept current by helper pushes. |
| `app.type` | Only `manuallySetAppType` mapped to the enum, else `UNSPECIFIED` | Client-side `getAppType` (main:231316) exists but classification for the server is left to the backend. |
| `textbox.{contents,before_text,selected_text,after_text}` | last `TextBoxInfo` payload, limited | Each of before/after/contents is cut to **500 characters** at a whitespace boundary (before from the right end, after from the left); not sent if `couldNotGetTextBoxInfo` or `useAxContext` is off (main:192788-192820). |
| `content_text` | `appContext.nearestTexts` from `AppContextUpdate` | AX-tree text near the focus. |
| `content_html` | `appContext.axHTML` from `AppContextHTML` | HTML-ified AX tree. |
| `vocabulary.screen_content_ax` | `axParsedWords`: proper nouns that the Aria web API (`extractProperNouns`) returns for `conversationId + "\n" + nearestTexts` (main:239300) | Comma list, last item dropped if the joined string exceeds 140 chars. |
| `vocabulary.screen_content_ocr` | `ocrParsedWords` | Only if OCR pref is on (below). |
| `vocabulary.variable_names/file_names` | `vsCodeVariableNames`/`vsCodeFileNames` from `CursorContextUpdate` (regex symbol parsing, caps 100 vars, 50 functions/classes; file cache) | Only for Cursor/VS Code-like apps. |
| `user_identifier` | `""` | Not filled in this build. |
| `session_dictation_apps` | `prefs.cache.statistics.totalApps` as `{bundle_id, url}` | |
| `screenshot` | `new Uint8Array()` always | **No screenshot bytes are sent in `Context`.** |
| `conversation` | never set by `getContext` | Conversation fields are not produced client-side in this build (the `conversationId` string from the helper is only prepended to the noun-extraction text). |

Context is not sent once. `GrpcClient.updateContext(reason)` is called each time a piece arrives: `"textbox"`, `"app_context"`, `"proper_nouns"`, `"screen_ocr"`, app info (main:200884, 238830, 239220). It is queued and sent on the open stream; `Context` also accompanies the stream start. So context is captured at hotkey press (the helper starts on `DictationStart`) and refreshed while the user is still talking, up to and after commit. It is not recaptured at commit.

### 4.2 Helper-side collection (binary evidence)

- Gate: AX trust (`AXIsProcessTrustedWithOptions`). Log strings: "Received a request to start accessibility services, but accessibility is not enabled!", "Waiting for message from Electron to start accessibility monitoring, permission not granted."
- Focused element: system-wide `AXUIElementCreateSystemWide` + `kAXFocusedUIElement`, falling back to the focused window of the frontmost app ("Couldn't get focused element or fallback window. Skipping AX Context collection."). Messaging timeout set with `AXUIElementSetMessagingTimeout`. Strings show these attributes: `AXRole`, `AXSubrole`, `AXValue`, `AXSelectedTextRange(s)`, `AXNumberOfCharacters`, `AXStringForRange`, `AXPlaceholderValue`, `AXTitle`, `AXDescription`, `AXHelp`, `AXChildren`, `AXVisibleChildren`, `AXParent`, `AXURL`, `AXPosition`, `AXSize`, `AXFocusedUIElement`, `AXMainWindow`, `AXTopLevelUIElement`, `AXDOMIdentifier`/`AXDOMClassList`, `AXEnhancedUserInterface`, and the text-marker family `AXSelectedTextMarkerRange`, `AXStartTextMarker`, `AXTextMarkerRange`, `AXIndexForTextMarker`, `AXAttributedStringForTextMarkerRange`. `AXSecureTextField` is a known role. Roles walked include `AXTextArea/TextField/ComboBox/StaticText/WebArea/Group/List/Table...`.
- Text box info: reads selected range and value; derives `selectedText`, `beforeText`, `afterText` by locating the selection in `contents` ("Failed to find unique range for selected text in contents using search method", "Selected text range (...) exceeds string length"). Descends into children when the focused node has no value ("Using contents from nested element", "Search depth/count exceeded"). Logs "Contents is too long" when it skips large values. Electron post-processes: for `com.apple.notes` a trailing newline before the caret is moved to `afterText` (caret-affinity fix), and text ending with the placeholders "Reply to Claude...", "Tip: Hit ⌘J for AI", "Tip: Hit Ctrl+J for AI" is dropped (main:238276-238300, 238760).
- `nearestTexts` is an AX tree walk around the focus with a time budget; the debug payload shows `nearestTextDurationMs` and a second path `markerRange*` (full document string through `AXTextMarkerRange`, no traversal, only in apps that support text markers; often empty). `ax-inspect-lib.mjs` documents this (lines 545-567, 913-1025). `markerRange` is only captured when `captureMarkerContext` is true, which Electron ties to the internal `shouldSaveAxText` pref (default off), so in production `nearestTexts` is what is used.
- HTML: AX tree converted to a positioned pseudo-HTML page (`ax-element` classes, `data-role=...`) with a time cap ("Ran out of time while converting AX to HTML, returning empty string").
- Chromium/Electron apps: sets `AXManualAccessibility` (and `AXEnhancedUserInterface`) on the app so web content exposes its tree ("Setting 'AXManualAccessibility' succeeded").
- Browser URL: `AppInfoUpdate.url`. The helper reads the browser window's address field via AX (focus-mode strings: "shouldBlock: no URL text found", "not a browser"); the feature flag `skip-url-search` can disable the extra search. Browsers listed in the Electron constants include Vivaldi (`com.vivaldi.Vivaldi`, main:142070, plus window-title regexes for `vivaldi` in the tab-strip monitor).
- Cursor/IDE: with `cursor-integration` on and a bundle id in `CURSOR_LIKE_APPS_BUNDLE_IDS` (or Cursor prefix), collects editor text areas and file tabs; checks "Screen Reader Optimized" mode (needed for editor text to be exposed).
- Coding CLI detection (`coding-cli-detection` flag): reports `codingCliAgent` (claude/codex...) with `high`/`low` confidence from the terminal window title / selected tab.
- Slack: a copy-based path (`GetSelectedTextViaCopy copyMode:slack`) parses the `slack/texty` clipboard flavour (Quill delta JSON) into HTML.

### 4.3 App categories (client constants, main:231000-231330)

- Messaging (mac): `com.apple.MobileSMS, net.whatsapp.WhatsApp, com.kishanbagaria.jack, com.facebook.archon, im.beeper, ru.keepcoder.Telegram, com.tdesktop.Telegram, org.whispersystems.signal-desktop, com.microsoft.teams, com.slack.Slack, com.discordapp.Discord, com.hnc.Discord, com.tinyspeck.slackmacgap, com.tencent.xinWeChat`, plus web hosts (`app.slack.com, web.whatsapp.com, discord.com, x.com ...`).
- Email (mac): `com.apple.mail, com.microsoft.Outlook, com.google.Gmail, com.superhuman.electron, ...` plus web hosts (`mail.google.com, outlook.office.com ...`).
- AI (mac): `com.openai.chat, com.openai.codex, com.anthropic.claudefordesktop, com.todesktop.230313mzl4w4u92 (Cursor), com.exafunction.windsurf, com.microsoft.VSCode, ai.perplexity.perplexity-mac, dev.warp.Warp-Stable, com.mitchellh.ghostty`, plus web hosts (`chatgpt.com, claude.ai, gemini.google.com ...`).
- Terminals: `com.apple.Terminal, com.googlecode.iterm2, dev.warp.Warp-Stable, com.mitchellh.ghostty, net.kovidgoyal.kitty, io.alacritty, co.zeit.hyper`. VS Code-like: Cursor, Windsurf, VS Code.
- `getAppType(bundleOrName, url)`: prefix match against AI -> `AI`; terminals -> `Other`; email -> `Email`; else `Other`. `getContextualNudgeAppType` additionally yields `Work`/`PersonalMessaging`/`Document`.
- Windows uses process-name lists instead of bundle ids.

### 4.4 Screenshots / OCR

The helper links neither ScreenCaptureKit nor Vision and imports no window-capture API (verified, see section 8). Screen capture is done in Electron: `desktopCapturer.getSources({types:["screen"], thumbnailSize})` for the display under the cursor, scaled to max 2048 px, PNG base64 (main:338214-338260). It is used only if both `prefs.user.shouldOCRScreenCapture` (default **false**) and `useAxContext` (default true) are on; it is started at dictation start (`ce.L(uuid)` in `startDictation`), sent over HTTPS to the Aria endpoint `extractProperNounsFromScreenCapture`, and the returned comma-separated words fill `screen_content_ocr`. The Electron app declares no screen-capture entitlement; the TCC "Screen Recording" permission is checked via `systemPreferences.getMediaAccessStatus("screen")` (main:318412) for this and for meeting capture.

Size limits seen: textbox 500 chars; `nearestTexts` is logged as head+tail 2500 chars each when over 5000 (debug only); AX HTML and `nearestTexts` are otherwise sent as received; code symbol caps 100/50/50; proper nouns capped at 140 chars joined.

## 5. Delivery (question 4)

**Decision (Electron)** - function chain `X` -> `Z` -> `pasteTextAndRelaunchHelperIfNeeded` (main:233190-233500, 242196):

1. Build `{plainText, htmlText, chunking}` from the final text (`X`):
   - `htmlText` is `<html><div style="font: inherit;">...</div></html>` when the text is a rich snippet (feature flag `RichTextSnippets` and the app allows HTML) or the email-signature flag is on and the text has HTML parts. Snippet outcomes are counted as `dictation.snippet_rich_text_insertion` with outcome `rich | plain_flag_off | plain_app_suppressed | plain_text_mutated | plain_chunked_terminal`. HTML is suppressed for Lovable (`lovable.dev`).
   - NBSP are turned to spaces for plain text. Trailing/leading boundary-space preservation for Superhuman and when the next char after the caret is non-space.
   - **Chunking for terminal CLIs**: if the target is detected as Claude Code (>=3 newlines or >600 chars) or Codex (>1000 chars) the text is split into pieces (600 chars/2 blank-line groups for Claude; 1000 for Codex) and joined with the literal delimiter `{{BREAK}}`; no HTML.
2. Remember last transcript; enterprise app deny-list may block (then only stored for "paste last").
3. Send `PasteText{pasteId, text, htmlText?, captureKeystrokeTrace?}` to the helper. Electron first saves the current clipboard text in memory (`mostRecentClipboardContentsString`) only to detect a wrongly inserted stale clipboard later (`xe`).
4. Afterwards optional `SimulateKeyPress` for "press Enter after paste" and cursor moves.

**Insertion (helper)** - evidence from helper strings; there is no AX-setValue path for dictation (the only AXValue-set path is the meeting consent-chat message, which falls back to paste):

- Strategy: clipboard + synthetic paste. "Pasting text len: ...", "Saved pasteboard types: ...", "Regular case of paste", "Restoring pasteboard contents in ...", "Restored pasteboard contents in ...". The helper saves all pasteboard item types, writes the text (and HTML via `NSPasteboardTypeHTML` when given), posts **Cmd+V** with `CGEventCreateKeyboardEvent` + `CGEventPost`, then restores the original pasteboard. Key code for `V` is found through the current keyboard layout (`TISGetInputSourceProperty` + `UCKeyTranslate`): "Detected V key code: ...", fallback "Failed to detect V key code, falling back to 0x09". Feature flag `shift-insert` switches to Shift+Insert (used for terminals). `disable-clipboard-restore` turns restoration off.
- Delivery of chunks: "Special case of paste with delimiters" splits on `{{BREAK}}` and pastes each piece in turn (so terminal UIs treat each as a separate paste).
- Delayed clipboard rendering (flag `failed-paste-notification`, shipped enabled): the pasteboard item is registered with an `NSPasteboardItemDataProvider` (`DelayedClipboardProvider`). Text is only materialized when the target app actually asks for it. The provider records "Delayed clipboard data requested" and cancels the failure timer ("Failed Timeout timer cancelled - paste succeeded"). If no app requests data before the timeout ("Delayed clipboard timeout -- failed paste likely - no app requested data within ...") the helper reports `PasteOutcome{success:false}`. After success or failure the original clipboard is restored after **500 ms** ("Scheduling clipboard restoration in 500ms", "Executing clipboard restoration").
- Preconditions and modifiers: "curKeysDown is non-empty on paste: ..." (the helper waits/handles held modifiers; `PasteAnalytics.modifierKeysDown`), `focusedControlChanged`, `hasPrivilegeIssues`, clipboard owner/open-app metrics.
- Re-focus: `StoreFocusedAppAndElement` at dictation start saves the frontmost app and focused AX element; if the focus moved, `FocusStoredAppAndElement` re-activates that app and element before pasting ("Attempting to focus stored app and element", "No valid element to focus, performing paste after app activation", "Performed paste operation as last resort", "Performed paste operation using fallback element").
- Blocked: Secure Event Input (`IsSecureEventInputEnabled`) is surfaced via `SecureInputStatus`; `PasteBlocked{reason}` triggers a notification (main:239640).

**Verification and fallback**

- `PasteOutcome` handler (main:239480-239580): success resets the helper relaunch counter and records timing; failure logs "Paste failed", counts `paste_text_failed`, and calls `De(lastTranscription)`, which shows a "void dictation" notification that offers to copy the text (or a generic `PasteFailed` notice) once per dictation. This is also triggered by the helper's `SuggestSelectTextbox` (no editable text box, main:239176). If the stale clipboard was inserted instead of the transcript, Electron logs severe "Inserted previous clipboard contents" and runs the same recovery.
- After insertion the helper keeps watching the text box for 60 s ("Starting edited text listener with EditTextManager v2", "Stopping edited text listener due to 60-second timeout"). It sends `DictatedTextVerification` with verdict `verified | verified_before_after | not_found | skipped` and reason `contents_empty | element_not_editable | listener_stopped | no_focused_element | position_not_found | textbox_too_long`. `verified_before_after` means the box equals pre-paste before text + pasted + pre-paste after text. It also sends `UpdateEditedText` (the user's later edit, used for learning). The Electron side logs these (main:233221-233270) and ships analytics 5 s after the paste.
- `accessibility_drop` at main:318320/318345 is a renderer page used for the permission-grant drag UI (drag the helper icon into System Settings), not an insertion fallback.
- Hold "paste last transcript": `cmd+ctrl+v` re-runs the same path with the last text; `cmd+ctrl+c` copies it (`clipboard.writeText`).

## 6. Permissions and entitlements (question 5)

| Permission | Who | Evidence |
|---|---|---|
| Accessibility | helper | `AXIsProcessTrustedWithOptions`, `CGPreflightPostEventAccess` (synthetic keys); helper idles until granted; `FlowPermissionGuide.app` helper app guides the user. |
| Input Monitoring | helper | `CGPreflightListenEventAccess`, event tap creation with `listenEventAccess` probe; log "Keyboard service event tap created with denied preflight". |
| Microphone | Electron renderer | `NSMicrophoneUsageDescription`; entitlement `com.apple.security.device.audio-input`; `getMediaAccessStatus("microphone")`. |
| Screen Recording | Electron (OCR/meeting) | `getMediaAccessStatus("screen")`; no entitlement needed on macOS. |
| System audio capture | helper (meetings) | `NSAudioCaptureUsageDescription`, `kTCCServiceAudioCapture` strings. |
| Bluetooth | helper (BLE mic ring) | `NSBluetoothAlwaysUsageDescription`. |

Entitlements: Electron app = `com.apple.security.cs.allow-jit`, `com.apple.security.device.audio-input` only. Swift helper = empty entitlement dict, hardened runtime flag `0x10000`, Developer ID Team `C9VQZ78H85`, **x86_64-only** Mach-O (so it runs under Rosetta on Apple Silicon). Helper frameworks: Sentry, MediaRemoteAdapter (media pause/resume). Linked frameworks include ApplicationServices, Carbon, CoreAudio, CoreBluetooth, CoreMediaIO, IOKit, WebKit (floating web panels) - no ScreenCaptureKit, no Vision.

## 7. Pseudocode (language-agnostic)

### 7.1 Hotkey state machine

```
const DEBOUNCE = 500ms
state: keysDown: Map<keycode, lastSeen>, status, isLocked, startTime, bindings[{keys:Set, action}]

on KeypressEvent(ev):                       # from helper, ordered by ev.index
    if ev.index != lastIndex+1: log desync
    if isModifierOnlyIgnorable(ev.key): return
    if press:  keysDown[ev.key] = now
    action = match(bindings, keysDown)       # set equality on press;
                                             # on release: if released key belongs to the chord that started the action
    if action == null: return
    handle(action, isRelease)

handle(ptt, press):
    if status not in {initializing, listening}: start(source=keyboard); isLocked=false
    elif now - startTime < DEBOUNCE and not commandMode:
        if isLocked: dismiss(TriplePress) else isLocked = true     # double-tap => hands-free
    elif isLocked: stop()
handle(ptt, release):
    if status == initializing or listening, not locked:
        if now - startTime < DEBOUNCE: after DEBOUNCE ms with no new press -> dismiss(DebouncePTT)
        else stop()
handle(popo, press):
    if recording: if isLocked and < DEBOUNCE: dismiss else stop()
    else: start(); isLocked = true
handle(lens, press|release): same as ptt but commandMode = true
handle(dismiss, press): cancel current dictation (and any popup)

start():  uuid=new; status=initializing; send helper DictationStart; open audio + gRPC; timers (19 min warn, 20 min stop)
stop():   status=stopping; stop audio; send helper DictationStop
every 5s: for key held > 10s not part of the active trigger -> ask helper CheckStaleKeys; drop confirmed stale
on TapRecoveryEvent / TapState re-enabled: drop stale keys; if trigger key stale while recording -> synthesize release
```

### 7.2 Context capture

```
on DictationStart (helper):
    if !axTrusted: return
    el = systemWide.focusedElement ?? frontApp.focusedWindow
    ensure app exposes AX (set AXManualAccessibility/AXEnhancedUserInterface true)
    send AppInfoUpdate (bundle, name, url from browser address bar, window title, coding-cli guess)
    tb = readTextBox(el):                 # role, value, selectedRange -> before/selected/after, isEditable
    send TextBoxInfo(tb)                  # and again whenever focus/selection changes while dictating
    nearest = walkAXTree(el, budget)      # texts near the focus, depth/count/time limits
    send AppContextUpdate(nearest, conversationId?, elementDescription)
    send AppContextHTML(axToHtml(el, budget))
    if IDE-like and flag: send CursorContextUpdate
on Electron receive each:
    store in ctx; if stream open: updateContext(reason)
    on AppContextUpdate: nouns = server.extractProperNouns(conversationId + "\n" + nearestTexts) -> ctx.axWords
    if prefs.ocr && prefs.useAx: png = screenshot(display under cursor, <=2048px); words = server.extractFromScreen(png) -> ctx.ocrWords
Context = {app, textbox(trimmed to 500 chars each), content_text, content_html, vocabulary{ax,ocr,vars,files}, session_dictation_apps, screenshot: empty}
```

### 7.3 Text insertion with fallback

```
insert(text, html?):
    pieces = text.split("{{BREAK}}")
    store focused app+element at dictation start (for refocus)
    if focus moved: activate stored app, refocus stored element (else fallback to current focus)
    saved = pasteboard.snapshotAllTypes()
    for piece in pieces:
        pasteboard.clear()
        if delayedRendering: pasteboard.setProvider(piece, html)   # data promised, not written
        else: pasteboard.setString(piece); if html: pasteboard.setHTML(html)
        wait until user modifier keys released (or note them)
        postKey(vKeyCodeForCurrentLayout(), Cmd)  (or Shift+Insert if flagged)   # keydown+keyup via CGEventPost
        if delayedRendering and provider not asked within timeout: report PasteOutcome(false); break
        else report PasteOutcome(true)
    after 500 ms: pasteboard.restore(saved)
    start 60 s watcher on the text box -> DictatedTextVerification, UpdateEditedText
on PasteOutcome(false) | PasteBlocked | SuggestSelectTextbox (Electron):
    show notification offering "copy transcript"; clipboard remains available via paste-last shortcut
```

## 8. Re-implementation notes

macOS:
- Keyboard: `CGEventTapCreate` (session tap, key down/up/flagsChanged + mouse buttons; needs Input Monitoring to listen, Accessibility to post/suppress); handle `kCGEventTapDisabledByTimeout/UserInput` by re-enabling; Fn/Globe arrives as a `flagsChanged` with the secondary-fn mask (keycode 63); Caps Lock needs IOKit HID (`IOHIDSystem`) to read/clear the toggle; check `IsSecureEventInputEnabled` and report which PID holds it. Keep a pressed-keys set, number events, and implement a `stale keys` query by comparing with `CGEventSourceKeyState`.
- AX: `AXUIElementCreateSystemWide`, `kAXFocusedUIElementAttribute`, `kAXRoleAttribute`, `kAXValueAttribute`, `kAXSelectedTextRangeAttribute`, `kAXStringForRangeParameterizedAttribute`, `kAXPlaceholderValueAttribute`, children traversal with depth/time budget, text-marker attributes for WebKit/Chromium, `AXObserver` on focus/selection changes, set `AXManualAccessibility` on Chromium/Electron apps, `AXUIElementSetMessagingTimeout`.
- Frontmost app: `NSWorkspace.frontmostApplication`; browser URL via AX address bar (and optionally AppleScript, not used here).
- Paste: `NSPasteboard` multi-type snapshot/restore, `NSPasteboardItemDataProvider` for lazy data, `CGEventCreateKeyboardEvent` + `CGEventPost`, layout-aware V keycode via `TISCopyCurrentKeyboardLayoutInputSource` + `UCKeyTranslate`.
- Permissions flow: `AXIsProcessTrustedWithOptions`, `CGPreflightListenEventAccess/CGRequestListenEventAccess`, microphone via AVFoundation, screen recording via `CGPreflightScreenCaptureAccess` only if OCR is wanted.
- IPC: any stdio/pipe JSON framing works; keep a uuid per request, a 3 s timeout, keepalive pings, restart with backoff, a message-length cap.

Windows (hints from the bundle, not reverse-engineered here): the schema also drives a C# helper (`windows-helper-app\...\<helper>.exe`). Windows keycodes are VK codes (table in main:146885+); flags `windows-key-up-simulation` and `windows-shortcut-masking-v2` suggest a low-level keyboard hook (`SetWindowsHookEx(WH_KEYBOARD_LL)`) that masks the Win key, UI Automation (`IUIAutomation`, TextPattern) in place of AX, and clipboard + `SendInput` Ctrl+V for insertion. Default chord is Ctrl+Win. Treat as inference.

## 9. Confidence and open questions

High confidence: spawn and stdio/fd3 transport, framing and escaping, uuid correlation, timeouts; message type names and payload fields; hotkey defaults, debounce 500 ms and the lock-by-double-press logic; Context field mapping and that `screenshot` is empty; OCR defaults and flow; helper API imports, entitlements, architecture; paste = clipboard + Cmd+V with 500 ms restore and delayed-rendering failure detection; verification verdict values.

Medium: exact AX attribute list used for the focused element (taken from string table, not decompiled call sites); how the helper builds `nearestTexts` (time budget, which roles count) and the HTML; that `UpdateShortcuts` makes the helper re-read `config.json` and which key in it (strings show `shortcutKeys`/`mouseShortcutKeys` and the file name, not the JSON path; locally the Electron-written file has `prefs.cache.splitKeybinds` and `prefs.user.shortcuts`); which bindings the helper suppresses versus passes through; Shift+Insert conditions; the delayed-render timeout value.

Open:
- Is the helper's event tap `.defaultTap` (can swallow) or `.listenOnly` for non-matching keys? Strings imply suppression of matched shortcuts and Esc during dictation; a Hopper-level read of `KeyboardService` is needed for the mask and tap location.
- Exact AX walk limits (element cap, time budget, per-role rules) and the 'conversation' construction for chat apps (the proto has the field; this build does not fill it client-side, the backend may infer it from `content_text`).
- The server-side AppType mapping (client only sends `UNSPECIFIED` unless the user sets it).
- Fn "doubleFn" semantics (keycode 179) and whether double-tap Fn ships as a binding.
- The Rosetta-only helper may be a packaging artefact; a universal rebuild would not change behaviour.

## 10. Validation

All checks are automated in `tools/ctx-validate.mjs` (read-only; shells out to `nm`, `strings`, `otool`, `codesign`, `lipo`; each check asserts a pattern that would fail if the claim were false). Run:

```
node tools/ctx-validate.mjs
```

Recorded result of the run for this document (2026-10-18): **69 PASS, 0 FAIL** (re-run after path scrub) ("all checks passed"). During development four checks initially failed because of wrong line ranges, which confirms they can fail; they were fixed by anchoring on content instead of fixed ranges.

Key claims and how to re-check by hand:

| Claim | Command | Expected |
|---|---|---|
| Helper spawn uses 4 stdio pipes, reads fd 3 | `grep -n 'stdio: \["pipe", "pipe", "pipe", "pipe"\]' work/pretty/main/index.js` and `grep -n 'helper.process.stdio\[3\]' work/pretty/main/index.js` | one hit each (241276; 241313) |
| Framing `|` / `+` | `sed -n 240266,240267p work/pretty/main/index.js` | `Xe = "\|"`, `Je = "+"` |
| Helper imports event tap and AX APIs | `nm -u "$APP/Contents/Resources/swift-helper-app-dist/<helper>.app/Contents/MacOS/<helper>" \| grep -E 'CGEventTapCreate\|CGEventPost\|AXUIElementCopyAttributeValue\|IsSecureEventInputEnabled'` | all four present |
| No screen-capture frameworks in the helper | `otool -L <helper> \| grep -ci 'ScreenCaptureKit\|Vision'` | `0` |
| Helper entitlements empty | `codesign -d --entitlements - --xml "<helper .app>"` | `<dict></dict>` |
| Electron entitlements | `codesign -d --entitlements - "$APP"` | `allow-jit`, `audio-input` only |
| Paste behavior strings | `strings -a <helper> \| grep -E 'Scheduling clipboard restoration in 500ms\|falling back to 0x09\|Special case of paste with delimiters\|Delayed clipboard timeout'` | 4 lines |
| ESC suppression and tap restart | `strings -a <helper> \| grep -E 'Suppressing escape key during dictation\|event tap disabled, attempting to restart'` | 2 lines |
| Defaults | `sed -n 147538,147546p work/pretty/main/index.js` | `[ke]: M.Ptt`, fn+space `Popo`, `Re` (fn+ctrl) `Lens`, esc `Dismiss` |
| Debounce | `grep -n '^ *R = 500,' work/pretty/main/index.js` | one hit followed by `B = 350,` |
| Screenshot always empty | `grep -n 'screenshot: new Uint8Array()' work/pretty/main/index.js` | hit inside `getContext` (201749) |
| OCR default off | `grep -n 'shouldOCRScreenCapture' work/pretty/main/index.js` | `shouldOCRScreenCapture: !1` (155138) |
| helper is x86_64 only | `lipo -info <helper>` | `is architecture: x86_64` |

REA MCP tools were not needed (the equivalent `nm`/`strings`/`otool` outputs were sufficient); no REA session was opened, so none had to be closed.
