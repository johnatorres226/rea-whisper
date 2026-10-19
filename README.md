# rea-whisper

A static reverse-engineering study of a commercial desktop voice-dictation app. The question it answers: how does push-to-talk speech become formatted text in whatever app has focus, and how does the floating "pill" with its waveform work?

The output is a specification: architecture, protocols, state machines, constants and **language-agnostic pseudocode**, detailed enough to re-implement the behavior in any language. No vendor code is included in this repository.

Start with **[docs/00-overview.md](docs/00-overview.md)**.

## Layout

| Path | Contents |
|---|---|
| `docs/00-overview.md` | End-to-end architecture, dictation timeline, orchestrator pseudocode, methodology |
| `docs/01…04-*.md` | Deep dives: audio capture, transport, trigger/context/delivery, status-pill GUI |
| `docs/proto/` | Reconstructed gRPC schema with validation notes |
| `prototypes/` | Clean-room re-implementations written from the pseudocode |
| `tools/` | Extraction and validation scripts (AST-based, never execute the target) |

## Reproduce and validate

```sh
tools/setup-workspace.sh "/Applications/<App>.app"   # extracts + formats into ./work (gitignored)
tools/validate-all.sh                                # every documented claim re-derived from the artifact
```

`work/` (extracted vendor code), `rea-out/` (raw analysis dumps) and `.brandrules` are gitignored and never committed. `tools/debrand.sh --check` gates commits so that the vendor's brand name stays out of the repository.

Analysis used [REA](https://github.com/morluto/rea) as an MCP server (JavaScript application graph, Electron fuse inspection) alongside Babel-AST scripts and standard Mach-O tooling.
