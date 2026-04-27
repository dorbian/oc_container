import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import z from "zod"
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import {
  OpenClawBridgeService,
  type OpenClawBridgeEvent,
  type OpenClawBridgeRecord,
} from "@/openclaw/bridge"

const EnsureSessionInput = {
  threadKey: z.string().min(1).describe("Stable OpenClaw thread or task key."),
  workspacePath: z.string().min(1).describe("Absolute workspace path for this thread."),
  title: z.string().optional().describe("Optional session title."),
  image: z.string().optional().describe("Optional container image override."),
  agent: z.string().optional().describe("Default OpenCode agent for this thread."),
  allowSubagents: z
    .boolean()
    .optional()
    .describe("Whether OpenCode may delegate to subagents via the task tool."),
  compactionPolicy: z
    .enum(["auto", "manual"])
    .optional()
    .describe("Per-thread compaction policy. 'manual' disables auto compaction for this container."),
}

const PromptAsyncInput = {
  threadKey: z.string().min(1).describe("Stable OpenClaw thread or task key."),
  workspacePath: z.string().optional().describe("Workspace path when creating a new thread."),
  title: z.string().optional().describe("Optional session title override."),
  image: z.string().optional().describe("Optional container image override."),
  agent: z.string().optional().describe("Agent to use for this specific prompt."),
  allowSubagents: z
    .boolean()
    .optional()
    .describe("Whether this prompt may delegate to subagents. Defaults to the thread setting."),
  compactionPolicy: z
    .enum(["auto", "manual"])
    .optional()
    .describe("Override the thread compaction policy. Changing this may restart the thread container."),
  prompt: z
    .record(z.string(), z.unknown())
    .describe("OpenCode prompt payload to forward to /session/:id/prompt_async."),
}

const ThreadKeyInput = {
  threadKey: z.string().min(1).describe("Stable OpenClaw thread or task key."),
}

const MessageQueryInput = {
  threadKey: z.string().min(1).describe("Stable OpenClaw thread or task key."),
  before: z.string().optional().describe("Optional pagination cursor."),
  limit: z.number().int().positive().max(500).optional().describe("Maximum message count to fetch."),
}

type McpSessionState = {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
}

const sessions = new Map<string, McpSessionState>()

function safeRecord(record: OpenClawBridgeRecord) {
  const { password: _password, ...safe } = record
  return safe
}

function jsonBlock(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2)
}

function toolText(title: string, value: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${title}\n${jsonBlock(value)}`,
      },
    ],
    structuredContent: value,
  }
}

function eventSummary(event: OpenClawBridgeEvent) {
  const type = event.payload.type
  const props = event.payload.properties ?? {}
  const text =
    typeof props.text === "string"
      ? props.text
      : typeof props.delta === "string"
        ? props.delta
        : typeof props.content === "string"
          ? props.content
          : undefined
  return text ? `${type}: ${text}` : type
}

async function streamPromptEvents(
  threadKey: string,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) return

  const bridge = OpenClawBridgeService.default()
  const { queue, unsubscribe } = await bridge.subscribe(threadKey)

  void (async () => {
    let progress = 0
    try {
      for await (const event of queue) {
        if (event === null || extra.signal.aborted) break
        progress += 1
        const summary = eventSummary(event)
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            message: summary,
            _meta: {
              threadKey,
              event,
            },
          },
        })
        await extra.sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "openclaw",
            data: {
              threadKey,
              event,
            },
          },
        })
        if (typeEndsRun(event.payload.type)) break
      }
    } catch (error) {
      await extra.sendNotification({
        method: "notifications/message",
        params: {
          level: "error",
          logger: "openclaw",
          data: {
            threadKey,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      })
    } finally {
      unsubscribe()
    }
  })()
}

function typeEndsRun(type: string) {
  return type.endsWith(".error") || type.endsWith(".done") || type.endsWith(".aborted")
}

function createServer() {
  const bridge = OpenClawBridgeService.default()
  const server = new McpServer(
    {
      name: "opencode-openclaw",
      version: InstallationVersion,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  )

  server.registerTool(
    "ensure_session",
    {
      title: "Ensure OpenClaw session",
      description:
        "Create or reconnect the persistent OpenCode container/session for an OpenClaw thread.",
      inputSchema: EnsureSessionInput,
    },
    async (args) => {
      const existing = await bridge.get(args.threadKey)
      const record = await bridge.ensureThread(args)
      const safe = safeRecord(record)
      return toolText("OpenClaw session ready.", {
        ...safe,
        resumed: Boolean(existing?.sessionID && existing.sessionID === record.sessionID),
      })
    },
  )

  server.registerTool(
    "prompt_async",
    {
      title: "Dispatch coding task",
      description:
        "Queue a prompt on a persistent OpenCode session and return immediately so the caller can continue other work. If the client supplies a progress token, OpenCode events are streamed back as MCP notifications.",
      inputSchema: PromptAsyncInput,
    },
    async (args, extra) => {
      const existing = await bridge.get(args.threadKey)
      const workspacePath = args.workspacePath ?? existing?.workspacePath
      if (!workspacePath) {
        throw new Error(`Thread "${args.threadKey}" has no registry entry; workspacePath is required`)
      }
      const record = await bridge.ensureThread({
        threadKey: args.threadKey,
        workspacePath,
        title: args.title,
        image: args.image,
      })
      await streamPromptEvents(args.threadKey, extra)
      const next = await bridge.promptAsync({
        ...args,
        workspacePath: args.workspacePath ?? record.workspacePath,
      })
      return toolText("Prompt accepted.", {
        accepted: true,
        threadKey: next.threadKey,
        sessionID: next.sessionID,
        containerID: next.containerID,
        serverUrl: next.serverUrl,
        image: next.image,
        updatedAt: next.updatedAt,
        streaming: extra._meta?.progressToken !== undefined,
      })
    },
  )

  server.registerTool(
    "get_session",
    {
      title: "Get OpenClaw session",
      description: "Inspect the persisted container/session mapping for a thread.",
      inputSchema: ThreadKeyInput,
    },
    async ({ threadKey }) => {
      const record = await bridge.get(threadKey)
      if (!record) return toolText("OpenClaw session not found.", { found: false, threadKey })
      return toolText("OpenClaw session found.", { found: true, ...safeRecord(record) })
    },
  )

  server.registerTool(
    "list_sessions",
    {
      title: "List OpenClaw sessions",
      description: "List all persisted OpenClaw thread to OpenCode session mappings.",
    },
    async () => {
      const sessions = (await bridge.list()).map(safeRecord)
      return toolText("OpenClaw sessions.", { sessions })
    },
  )

  server.registerTool(
    "get_messages",
    {
      title: "Get OpenClaw messages",
      description: "Fetch session messages for a thread from the underlying OpenCode server.",
      inputSchema: MessageQueryInput,
    },
    async ({ threadKey, before, limit }) => {
      const messages = await bridge.messages(threadKey, { before, limit })
      return toolText("OpenClaw messages.", {
        threadKey,
        messages: messages as unknown as Record<string, unknown>[],
      })
    },
  )

  server.registerTool(
    "abort_session",
    {
      title: "Abort OpenClaw session",
      description: "Abort the currently running prompt for a thread.",
      inputSchema: ThreadKeyInput,
    },
    async ({ threadKey }) => {
      await bridge.abort(threadKey)
      return toolText("OpenClaw session aborted.", { ok: true, threadKey })
    },
  )

  server.registerTool(
    "dispose_session",
    {
      title: "Dispose OpenClaw session",
      description: "Stop the per-thread container and remove the persisted thread mapping.",
      inputSchema: ThreadKeyInput,
    },
    async ({ threadKey }) => {
      const disposed = await bridge.dispose(threadKey)
      return toolText("OpenClaw session disposed.", { ok: disposed, threadKey })
    },
  )

  return server
}

async function createSessionState() {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, {
        server,
        transport,
      })
    },
    onsessionclosed: async (sessionId) => {
      const current = sessions.get(sessionId)
      if (!current) return
      sessions.delete(sessionId)
      await current.server.close().catch(() => undefined)
    },
  })

  const server = createServer()
  await server.connect(transport)
  return { server, transport }
}

function getSessionState(sessionId: string | undefined) {
  if (!sessionId) return
  return sessions.get(sessionId)
}

export const OpenClawMcpRoutes = () =>
  new Hono()
    .post("/mcp", async (c) => {
      const sessionId = c.req.header("mcp-session-id")
      const current = getSessionState(sessionId)

      if (current) return current.transport.handleRequest(c.req.raw)

      const state = await createSessionState()
      return state.transport.handleRequest(c.req.raw)
    })
    .get("/mcp", async (c) => {
      const current = getSessionState(c.req.header("mcp-session-id"))
      if (!current) return c.text("Invalid or missing MCP session ID", 400)
      return current.transport.handleRequest(c.req.raw)
    })
    .delete("/mcp", async (c) => {
      const current = getSessionState(c.req.header("mcp-session-id"))
      if (!current) return c.text("Invalid or missing MCP session ID", 400)
      return current.transport.handleRequest(c.req.raw)
    })
