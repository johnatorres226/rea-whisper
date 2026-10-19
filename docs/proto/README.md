# `flow_api.v1`: reconstructed dictation wire protocol

`flow_api_v1.proto` is the gRPC/protobuf contract the subject app desktop client (v1.6.1102) uses to talk to its transcription + formatting backend. It was **not** shipped as a `.proto`. It was rebuilt from the protobuf-ts reflection metadata compiled into the main-process bundle (`.webpack/main/index.js`).

## How to regenerate

```sh
cd tools && npm install
node --max-old-space-size=8192 tools/extract-proto.mjs <app>/.webpack/main/index.js > docs/proto/flow_api_v1.proto
```

`extract-proto.mjs` parses the bundle (it never executes it) and does the following:

1. Finds every `class extends MessageType { constructor() { super("<pkg>.<Name>", [fields…]) } }`.
2. Resolves `T: () => ident` message references through lexical scope to the class that declares the referenced type name. Well-known types such as `google.protobuf.Duration` are resolved the same way.
3. Resolves enums by finding the TypeScript enum IIFE `e[e.NAME = n] = "NAME"`. If the enum lives in another webpack module, it follows `ns = require(id)` → `n.d(exports, { X: () => local })`.
4. Finds `new ServiceType("<pkg>.<Svc>", [{name, I, O, clientStreaming, serverStreaming}])`.

## Validation (rerun these)

| Check | Command | Result (1.6.1102) |
|---|---|---|
| Schema compiles | `protoc -I docs/proto -I <protobuf include> --descriptor_set_out=/dev/null flow_api_v1.proto` | OK (libprotoc 25.3) |
| Field numbers and wire types match the bundle's serializers. This is an independent path: it reads the `writer.tag(N, WireType.X)` calls in each `internalBinaryWrite`, not the reflection list. | `node tools/verify-proto-wire.mjs <bundle> docs/proto/flow_api_v1.proto` | `checked 146 fields across 35 messages: ALL MATCH` |
| The verifier can fail | Change `Heartbeat.audio_received_seconds` from float to double and renumber `Request.commit` from 4 to 5, then rerun | 2 mismatches reported, exit 1 |

What is **not** recovered: field options other than names. `buf.validate` constraints are present in the bundle but not emitted. One example: `AudioPackets.items` is required and holds 1 to 18000 items. Comments and the server implementation are also not recovered.

## The shape in one screen

```
service TranscriptionService {
  rpc Transcribe      (Request)        returns (Response);         // unary: whole-utterance
  rpc TranscribeStream(stream Request) returns (stream Response);  // bidi: live dictation
}
Request  = { init: Init | context: Context | payload: Payload | commit: Commit }   // one concern per message
Response = { result: Result | state: State | all_states: [State] | heartbeat: Heartbeat }

Init     = { metadata{user_id, session_id, request_id, audio_encoding(WAV|OPUS), environment, client{name,platform,version}, …},
             preferences{user, language[], vocabulary(static), replacements(personal/team + snippets), style_config},
             state }
Context  = { app{name,bundle_id,url,type}, textbox, vocabulary(dynamic: AX text, OCR, variable/file names),
             content_text, content_html, session_dictation_apps[], screenshot(bytes), conversation{participants, messages[]} }
Payload  = oneof { audio_packets{ items: [bytes] }  |  audio_file{ data: bytes } }
Commit   = TRUE | FALSE                                   // "I'm done talking"
Heartbeat= { audio_received_seconds, commit_ack }         // server → client liveness / ack
Result   = { output: Transcription, audio_duration, response_time{transcribe, format, external_asr_time, external_llm_time, …},
             status(FORMATTED | RAW_TRANSCRIPT | ERROR), format_skip_reason, transcript_origin, … }
Origin   = WHISPER | SCRIBE | VOXTRAL | QWEN | MIXTURE    // multiple ASR engines; MIXTURE = selected/combined beam
```

The schema itself shows that **ASR and the LLM "formatting" pass both happen server-side**. `Progress` reports `transcriber_finished`, `formatter_finished` and `post_processing_finished`. `ResponseTime` separates `external_asr_time` from `external_llm_time`. The client sends audio plus context, and it receives formatted text.
