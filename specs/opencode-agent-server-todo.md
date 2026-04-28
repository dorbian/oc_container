# OpenCode Agent Server Checklist

## Goal

Make `opencode` usable as a self-sufficient coding agent server for ACP-style clients such as Zed, while preserving model selection and improving automatic model routing.

## Checklist

- [x] Confirm `opencode acp` already exposes an ACP agent server suitable for client integration.
- [x] Confirm `opencode serve` already exposes the headless HTTP server used by OpenClaw.
- [x] Add a dedicated Codex-like primary mode that ACP clients can select by name.
- [x] Improve model routing so lightweight planning and exploration agents prefer `small_model` when configured.
- [x] Allow `opencode acp` to connect to an already-running `opencode serve` backend via `--server-url`.
- [ ] Verify the new mode appears through the ACP agent list.
- [ ] Verify prompt execution still works for both coding and subagent flows.
- [ ] Verify Zed can launch `opencode acp --server-url <container-url>` against a persistent container backend.
- [x] Document recommended client entrypoints for Zed, ACP, and OpenClaw.

## Recommended usage

- Zed: use the bundled `packages/extensions/zed` agent server entry, which launches `opencode acp`
- Zed with a persistent container backend: run `opencode serve` in the container, then point Zed at `opencode acp --server-url http://127.0.0.1:<published-port>`
- ACP clients in general: run `opencode acp`
- Headless HTTP server: run `opencode serve`
- OpenClaw bridge thread default agent: pass `agent: "codex"` when ensuring or prompting a thread

## Model routing notes

- Main coding work uses the current or default model unless the request explicitly overrides it.
- Lightweight agents such as `plan` and `explore` prefer `small_model` when available.
- If `small_model` is not configured or not available for the active provider, routing falls back to the current model.
