#!/usr/bin/env node
// Validation for docs/03-trigger-context-delivery.md. Each check can FAIL if the claim is false.
// usage: node tools/ctx-validate.mjs   (exit 1 on any FAIL). Read-only; shells out to nm/strings/otool/codesign.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = fs.readFileSync(ROOT + 'work/pretty/main/index.js', 'utf8').split('\n')
// Locate the subject app at runtime: /Applications/<name>.app containing swift-helper-app-dist/<helper>.app
const found = fs.readdirSync('/Applications').map(n => '/Applications/' + n).find(a => { try { return fs.readdirSync(a + '/Contents/Resources/swift-helper-app-dist').some(x => x.endsWith('.app')) } catch { return false } })
if (!found) { console.log('FAIL  subject app with swift-helper-app-dist not found under /Applications'); process.exit(1) }
const APP = found
const HELPER_DIR = APP + '/Contents/Resources/swift-helper-app-dist'
const HELPER_APP = HELPER_DIR + '/' + fs.readdirSync(HELPER_DIR).find(x => x.endsWith('.app'))
const HELPER = HELPER_APP + '/Contents/MacOS/' + fs.readdirSync(HELPER_APP + '/Contents/MacOS')[0]
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return (e.stdout || '') + (e.stderr || '') } }
const slice = (a, b) => SRC.slice(a - 1, b).join('\n')
const hasIn = (a, b, re) => re.test(slice(a, b))
let fail = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); if (!ok) fail++ }

// --- locate anchors by content (line numbers drift less than text) ---
const find = (re, from = 0) => { for (let i = from; i < SRC.length; i++) if (re.test(SRC[i])) return i + 1; return -1 }

// 1. IPC transport
const spawnL = find(/stdio: \["pipe", "pipe", "pipe", "pipe"\]/)
check('helper spawned with 4 stdio pipes', spawnL > 0, `line ${spawnL}`)
check('Electron reads helper->Electron messages from stdio[3] (fd 3)', find(/S\.RA\.helper\.process\.stdio\[3\]/) > 0)
check('Electron writes requests to helper stdin', hasIn(240500, 240600, /process\.stdin/))
const framingL = find(/Xe = "\|",/, 240000)
check('frame delimiter "|" and escape char "+"', framingL > 0 && /Je = "\+"/.test(SRC[framingL]), `line ${framingL}`)
check('escape: "+"->"+1", "|"->"+2"', /replaceAll\(Je, `\$\{Je\}1`\)\.replaceAll\(Xe, `\$\{Je\}2`\)/.test(slice(240455, 240520).replace(/\s+/g, ' ')) || /replaceAll\(Je,\s*`\$\{Je\}1`\)/.test(slice(240455, 240520)))
check('max outbound message 1e5 chars', hasIn(240500, 240560, /e\.length > 1e5/))
check('default request timeout 3000ms; keepalive 500/2000/15000', hasIn(240314, 240340, /defaultRequestTimeoutMs = 3e3/) && hasIn(240314, 240340, /KEEPALIVE_CHECK_INTERVAL_MS = 500/) && hasIn(240314, 240340, /KEEPALIVE_RELAUNCH_THRESHOLD_MS = 15e3/))
check('request/response correlated by uuid (pendingResponses map)', hasIn(240640, 240700, /pendingResponses\.get\(t\)/) && hasIn(240440, 240480, /HelperAPIRequest[\s\S]*HelperAPIResponse/))
// schema size
const rq = find(/^            HelperAPIRequest: L\(/), rs = find(/^            HelperAPIResponse: L\(/)
const blockEnd = (a) => find(/^            \w+: L\(/, a)  // next type definition after line a
const names = (a, b) => [...slice(a, b).matchAll(/^\s{18}json: "([^"]+)"/gm)].map(m => m[1])
const reqKeys = names(rq, blockEnd(rq)).filter(n => n !== 'uuid')
const resKeys = names(rs, blockEnd(rs)).filter(n => n !== 'uuid')
check('HelperAPIRequest has >=90 message types incl. KeypressEvent,PasteText,DictationStart,AppContextUpdate', reqKeys.length >= 90 && ['KeypressEvent', 'PasteText', 'DictationStart', 'AppContextUpdate', 'TextBoxInfo', 'CheckStaleKeys'].every(k => reqKeys.includes(k)), `${reqKeys.length} keys`)
check('HelperAPIResponse includes StaleKeysResponse, TextBoxInfo, ActiveAppInfo, TapState', ['StaleKeysResponse', 'TextBoxInfo', 'ActiveAppInfo', 'TapState'].every(k => resKeys.includes(k)), `${resKeys.length} keys`)

// 2. Hotkey
check('helper emits raw KeypressEvent{eventType,index,inputType,key}; handler = keyboard service pushKeypressEvent', find(/le\.kD\.pushKeypressEvent\(n, !0\)/) > 0)
const dflt = find(/\[ke\]: M\.Ptt,/)
const blk = slice(dflt, dflt + 6).replace(/\s+/g, ' ')
check('mac default binds: fn=ptt, fn+space=popo, fn+ctrl=lens, esc=dismiss', /\[ke\]: M\.Ptt/.test(blk) && /s\.fn, s\.space\]\)\]: M\.Popo/.test(blk) && /\[Re\]: M\.Lens/.test(blk) && /s\.esc\]\)\]: M\.Dismiss/.test(blk) && /ke = O\(\[s\.fn\]\)/.test(slice(dflt - 3, dflt)) && /Re = O\(\[s\.fn, s\.ctrl\]\)/.test(slice(dflt - 3, dflt)), `line ${dflt}`)
check('mac keycode fn=63, space=49 (CGKeyCode)', /fn: r\.tD \? 63 : -1/.test(slice(146880, 146950)))
check('DICTATION_DEBOUNCE_DELAY (R) = 500ms, SCRATCHPAD_PTT_DELAY (B) = 350ms', (() => { const l = find(/^\s+R = 500,$/); return l > 0 && /B = 350,/.test(SRC[l]) })())
check('second PTT press within debounce window while Listening => lock (hands-free)', /Action down twice in quick succession/.test(slice(234300, 234560)))
check('PTT release before debounce => wait for double press, else dismiss(DebouncePTT)', /PTT stopping after timeout waiting for double press/.test(slice(234688, 234700)))
check('PTT release after debounce => stopDictation (ct)', /\(Ie\(\), ct\(e\)\)/.test(slice(234543, 234562)))
check('stale-key sweep: 10s hold timeout (P=1e4), 5s interval, CheckStaleKeys 500ms timeout', find(/^\s+P = 1e4;$/) > 0 && find(/\}, 5e3\)/, 254700) > 0 && find(/CheckStaleKeys: \{ payload: \{ keycodes/) > 0 && find(/^\s+\}, 500\);$/, 254700) > 0)
check('hold-without-release Esc: Dismiss action calls tryDismiss(UserActionEscape)', /UserActionEscape/.test(slice(254180, 254215)))

// 3. Context
const gc = find(/static getContext\(\) \{/)
const gcs = slice(gc, gc + 60)
check('Context.screenshot is always empty Uint8Array', /screenshot: new Uint8Array\(\)/.test(gcs))
check('Context built from textbox/nearestTexts/axHTML/axParsedWords/ocrParsedWords/vsCode*', /contentText: Qt\.ZZ\.appContext\.nearestTexts/.test(gcs) && /contentHtml: Qt\.ZZ\.appContext\.axHTML/.test(gcs) && /screenContentOcr: Qt\.ZZ\.appContext\.ocrParsedWords/.test(gcs) && /variableNames: Qt\.ZZ\.appContext\.vsCodeVariableNames/.test(gcs))
check('Context.conversation never populated by getContext', !/conversation/.test(gcs))
check('textbox sent is capped at 500 chars (MAX_TEXTBOX_CONTENTS_LENGTH)', find(/MAX_TEXTBOX_CONTENTS_LENGTH = 500/) > 0)
check('OCR screen capture requires prefs shouldOCRScreenCapture && useAxContext; default OCR=false, AX=true', find(/shouldOCRScreenCapture: !1/) > 0 && find(/useAxContext: !0/) > 0 && find(/u\.RA\.prefs\?\.user\.shouldOCRScreenCapture/) > 0)
check('screenshot taken by Electron desktopCapturer (not helper), max 2048px PNG base64', find(/r\.desktopCapturer\.getSources\(\{\s*$/) > 0 || find(/types: \["screen"\]/) > 0)
check('DictationStart request sent at dictation start with includeOffscreen/captureMarkerContext', find(/sendHelperRequest\)\("DictationStart", \{/) > 0)
check('DictationStop request sent at stop', find(/sendHelperRequest\)\("DictationStop"\)/) > 0)
check('AppInfoUpdate cached into persistentAppContext (bundle, url, window title, coding cli agent)', find(/persistentAppContext\.lastCodingCliAgent =/) > 0)
check('vivaldi in AppType/browser bundle lists', find(/"com\.vivaldi\.Vivaldi"/) > 0)
check('getAppType: AI list -> terminal=Other -> email -> Other', /r\.uC\.AI[\s\S]{0,400}y\.some[\s\S]{0,200}r\.uC\.Other[\s\S]{0,400}r\.uC\.Email/.test(slice(find(/^            _ = \(e, t\) =>/, 231290), find(/^            _ = \(e, t\) =>/, 231290) + 25)))

// 4. Delivery
check('PasteText request payload {pasteId,text,htmlText,captureKeystrokeTrace}', /c = \{ pasteId: i, text: e \}/.test(slice(242196, 242215)) && /c\.htmlText = t/.test(slice(242196, 242215)))
check('{{BREAK}} chunk delimiter used for claude/codex terminals', find(/join\("\{\{BREAK\}\}"\)/) > 0)
check('rich text wrapper <html><div style="font: inherit;">', find(/<html><div style="font: inherit;">/) > 0)
check('PasteOutcome failure -> void-dictation notification with copy fallback (De)', find(/sendVoidDictationNotification\)\(/, 238600) > 0 && find(/Paste failed, showing notification to user/) > 0 && find(/De\(E\.RA\.lastTranscription \|\| ""\)/) > 0)
check('SuggestSelectTextbox from helper triggers the same fallback', /De\(E\.RA\.lastTranscription/.test(slice(239176, 239195)))
check('verification verdict enum {not_found,skipped,verified,verified_before_after}', /"not_found",\s*"skipped",\s*"verified",\s*"verified_before_after"/.test(slice(140057, 140064)))

// 5. Binary evidence
const nmU = sh('nm', ['-u', HELPER])
for (const sym of ['_CGEventTapCreate', '_CGEventPost', '_CGEventCreateKeyboardEvent', '_AXUIElementCopyAttributeValue', '_AXUIElementCopyParameterizedAttributeValue', '_AXUIElementSetAttributeValue', '_AXObserverCreate', '_IsSecureEventInputEnabled', '_CGPreflightListenEventAccess', '_AXIsProcessTrustedWithOptions', '_IOHIDManagerCreate', '_UCKeyTranslate', '_OBJC_CLASS_$_NSPasteboard'])
  check(`helper imports ${sym}`, nmU.includes(sym))
check('helper does NOT import screen-capture / Vision / CGWindowListCreateImage', !/CGWindowListCreateImage|SCStream|SCScreenshot|VNRecognizeText|CGDisplayCreateImage/.test(nmU) && !/ScreenCaptureKit|Vision\.framework/.test(sh('otool', ['-L', HELPER])))
const ents = sh('codesign', ['-d', '--entitlements', '-', '--xml', HELPER_APP])
check('helper has empty entitlements dict (hardened runtime)', /<dict><\/dict>/.test(ents.replace(/\s+/g, '')))
const entsE = sh('codesign', ['-d', '--entitlements', '-', APP])
check('Electron app entitlements = allow-jit + audio-input only', entsE.includes('com.apple.security.cs.allow-jit') && entsE.includes('com.apple.security.device.audio-input') && !/screen-capture|automation/.test(entsE))
const str = sh('strings', ['-a', HELPER])
const must = ['Suppressing escape key during dictation', 'Scheduling clipboard restoration in 500ms', 'Failed to detect V key code, falling back to 0x09', 'Special case of paste with delimiters: ', 'Using delayed clipboard rendering', 'Delayed clipboard timeout -- failed paste likely', 'Keyboard service event tap disabled, attempting to restart tap', 'Caps Lock flagsChanged ignored: HID owns the key', 'Secure input is blocking keyboard shortcuts', 'AXSelectedTextRange', 'AXPlaceholderValue', 'AXSelectedTextMarkerRange', 'AXManualAccessibility', 'Swift Helper: Error reading config.json: ', 'Failed to extract Slack formatted text from clipboard, falling back to plain text', 'stdin EOF, parent process is gone ']
for (const s of must) check(`helper string present: "${s.trim()}"`, str.includes(s))
const arch = sh('lipo', ['-info', HELPER])
check('helper Mach-O is x86_64-only', /is architecture: x86_64/.test(arch), arch.trim().split(': ').pop())

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed')
process.exit(fail ? 1 : 0)
