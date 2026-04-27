# OpenClaw OpenCode Bridge Deployment

This document describes the production shape for running the OpenClaw bridge inside a container while allowing it to launch sibling OpenCode worker containers on the host.

## Runtime model

- One bridge server process exposes:
  - `GET /global/openclaw/thread/:threadKey/event`
  - `POST /global/openclaw/thread/:threadKey/ensure`
  - `POST /global/openclaw/thread/:threadKey/prompt_async`
  - `POST /global/openclaw/thread/:threadKey/abort`
  - `POST /global/openclaw/thread/:threadKey/dispose`
  - `POST|GET|DELETE /global/openclaw/mcp`
- One OpenClaw `threadKey` maps to one persistent OpenCode session.
- One OpenClaw `threadKey` also maps to one long-lived OpenCode worker container.
- Worker containers run `opencode serve`.

## Host runtime access

The bridge container must be able to talk to the host container runtime.

Required:

- Docker or Podman CLI available inside the bridge container.
- Access to the host runtime socket.

Docker example:

```bash
docker run \
  --rm \
  -p 4096:4096 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/openclaw/workspaces:/workspaces \
  -v /srv/openclaw/opencode-state:/bridge-state \
  -e OPENCODE_OPENCLAW_CONTAINER_RUNTIME=docker \
  -e OPENCODE_OPENCLAW_IMAGE=ghcr.io/<owner>/opencode-session:dev \
  -e OPENCODE_OPENCLAW_WORKSPACE_CONTAINER_PREFIX=/workspaces \
  -e OPENCODE_OPENCLAW_WORKSPACE_HOST_PREFIX=/srv/openclaw/workspaces \
  -e OPENCODE_OPENCLAW_STATE_CONTAINER_PREFIX=/bridge-state \
  -e OPENCODE_OPENCLAW_STATE_HOST_PREFIX=/srv/openclaw/opencode-state \
  -e XDG_STATE_HOME=/bridge-state \
  <bridge-image>
```

## Why path translation is required

When the bridge runs inside a container but launches sibling containers on the host daemon, bind mounts passed to `docker run` must be host-visible paths.

That means these paths need translation:

- workspace mount source
- bridge state root used for OpenCode state/data/config mounts

The bridge now supports this translation through environment variables.

## Path mapping environment variables

Workspace mapping:

- `OPENCODE_OPENCLAW_WORKSPACE_CONTAINER_PREFIX`
- `OPENCODE_OPENCLAW_WORKSPACE_HOST_PREFIX`

State mapping:

- `OPENCODE_OPENCLAW_STATE_CONTAINER_PREFIX`
- `OPENCODE_OPENCLAW_STATE_HOST_PREFIX`

Behavior:

- If neither variable pair is set, the bridge uses the original paths directly.
- If one variable in a pair is set, both must be set.
- The input path must be under the configured container prefix.

Example:

- OpenClaw sends `workspacePath=/workspaces/repo-a`
- bridge container sees `/workspaces/repo-a`
- host daemon receives `/srv/openclaw/workspaces/repo-a`

## MCP endpoint for OpenClaw

OpenClaw should connect to:

- `POST /global/openclaw/mcp`
- `GET /global/openclaw/mcp`
- `DELETE /global/openclaw/mcp`

Use MCP streamable HTTP session flow:

1. Send `initialize` to `POST /global/openclaw/mcp`
2. Store the returned `mcp-session-id` header
3. Reuse that header on later `POST`, `GET`, and `DELETE` calls

## MCP tools

- `ensure_session`
- `prompt_async`
- `get_session`
- `list_sessions`
- `get_messages`
- `abort_session`
- `dispose_session`

## Worker controls

The bridge exposes these per-thread or per-prompt controls:

- `agent`
- `allowSubagents`
- `compactionPolicy`

Semantics:

- `agent`: default or per-run OpenCode agent name
- `allowSubagents=false`: disables task-tool delegation and injects a no-subagent system guard
- `compactionPolicy=manual`: disables auto compaction in that thread's worker container

Changing `compactionPolicy` may restart the worker container, but state is preserved through mounted `state/data/config`.

## OpenClaw integration sequence

Recommended flow:

1. Call `ensure_session` with:
   - `threadKey`
   - `workspacePath`
   - optional `agent`
   - optional `allowSubagents`
   - optional `compactionPolicy`
2. Call `prompt_async` with the same `threadKey`
3. Supply an MCP `_meta.progressToken` if live streaming is desired
4. Continue unrelated OpenClaw work immediately
5. Watch:
   - `notifications/progress`
   - `notifications/message`
6. Call `get_messages` on reconnect or after completion
7. Call `abort_session` if needed
8. Call `dispose_session` when the task is finished
