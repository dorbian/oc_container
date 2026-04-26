import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { zodObject } from "@/util/effect-zod"
import { SessionPrompt } from "@/session/prompt"
import { AsyncQueue } from "@/util/queue"
import { errors } from "../error"
import { OpenClawBridgeService } from "@/openclaw/bridge"

const ThreadParams = z.object({
  threadKey: z.string().min(1),
})

const RecordSchema = z.object({
  threadKey: z.string(),
  workspacePath: z.string(),
  workspaceMountPath: z.string(),
  sessionID: z.string().optional(),
  containerID: z.string().optional(),
  containerName: z.string(),
  serverUrl: z.string().optional(),
  runtime: z.enum(["docker", "podman"]).optional(),
  image: z.string(),
  stateRoot: z.string(),
  port: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const EnsureBody = z.object({
  workspacePath: z.string(),
  title: z.string().optional(),
  image: z.string().optional(),
})

const PromptBody = z.object({
  workspacePath: z.string().optional(),
  title: z.string().optional(),
  image: z.string().optional(),
  prompt: zodObject(SessionPrompt.PromptInput).omit({ sessionID: true }),
})

const MessageQuery = z.object({
  limit: z.coerce.number().optional(),
  before: z.string().optional(),
})

export const OpenClawRoutes = () => {
  const bridge = OpenClawBridgeService.default()

  return new Hono()
    .get(
      "/thread/:threadKey",
      describeRoute({
        summary: "Get OpenClaw thread bridge",
        operationId: "openclaw.thread.get",
        responses: {
          200: {
            description: "OpenClaw bridge record",
            content: {
              "application/json": {
                schema: resolver(RecordSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", ThreadParams),
      async (c) => {
        const record = await bridge.get(c.req.valid("param").threadKey)
        if (!record) return c.json({ message: "Thread not found" }, 404)
        const { password: _password, ...safe } = record
        return c.json(safe)
      },
    )
    .post(
      "/thread/:threadKey/ensure",
      describeRoute({
        summary: "Ensure OpenClaw bridge thread",
        operationId: "openclaw.thread.ensure",
        responses: {
          200: {
            description: "OpenClaw bridge record",
            content: {
              "application/json": {
                schema: resolver(RecordSchema),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", ThreadParams),
      validator("json", EnsureBody),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        const record = await bridge.ensureThread({
          threadKey: params.threadKey,
          workspacePath: body.workspacePath,
          title: body.title,
          image: body.image,
        })
        const { password: _password, ...safe } = record
        return c.json(safe)
      },
    )
    .post(
      "/thread/:threadKey/prompt_async",
      describeRoute({
        summary: "Send OpenClaw bridge prompt",
        operationId: "openclaw.thread.prompt_async",
        responses: {
          200: {
            description: "OpenClaw bridge record",
            content: {
              "application/json": {
                schema: resolver(RecordSchema),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", ThreadParams),
      validator("json", PromptBody),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        const record = await bridge.promptAsync({
          threadKey: params.threadKey,
          workspacePath: body.workspacePath,
          title: body.title,
          image: body.image,
          prompt: body.prompt,
        })
        const { password: _password, ...safe } = record
        return c.json(safe)
      },
    )
    .post(
      "/thread/:threadKey/abort",
      describeRoute({
        summary: "Abort OpenClaw bridge thread",
        operationId: "openclaw.thread.abort",
        responses: {
          200: {
            description: "Aborted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", ThreadParams),
      async (c) => c.json(await bridge.abort(c.req.valid("param").threadKey)),
    )
    .post(
      "/thread/:threadKey/dispose",
      describeRoute({
        summary: "Dispose OpenClaw bridge thread",
        operationId: "openclaw.thread.dispose",
        responses: {
          200: {
            description: "Disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", ThreadParams),
      async (c) => c.json(await bridge.dispose(c.req.valid("param").threadKey)),
    )
    .get(
      "/thread/:threadKey/message",
      describeRoute({
        summary: "Get OpenClaw bridge messages",
        operationId: "openclaw.thread.messages",
        responses: {
          200: {
            description: "Messages",
            content: {
              "application/json": {
                schema: resolver(z.array(z.unknown())),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", ThreadParams),
      validator("query", MessageQuery),
      async (c) => {
        const params = c.req.valid("param")
        const query = c.req.valid("query")
        return c.json(await bridge.messages(params.threadKey, query))
      },
    )
    .get(
      "/thread/:threadKey/event",
      describeRoute({
        summary: "Subscribe to OpenClaw bridge events",
        operationId: "openclaw.thread.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z.object({
                    directory: z.string().optional(),
                    project: z.string().optional(),
                    workspace: z.string().optional(),
                    payload: z.object({
                      type: z.string(),
                      properties: z.record(z.string(), z.unknown()).optional(),
                    }),
                  }),
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", ThreadParams),
      async (c) => {
        const { queue, unsubscribe } = await bridge.subscribe(c.req.valid("param").threadKey)
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamSSE(c, async (stream) => {
          const heartbeat = setInterval(() => {
            void stream.writeSSE({
              data: JSON.stringify({
                payload: {
                  type: "server.heartbeat",
                  properties: {},
                },
              }),
            })
          }, 10_000)

          const local = new AsyncQueue<string | null>()
          local.push(
            JSON.stringify({
              payload: {
                type: "server.connected",
                properties: {},
              },
            }),
          )

          const stop = () => {
            clearInterval(heartbeat)
            unsubscribe()
            local.push(null)
          }
          stream.onAbort(stop)

          const pump = (async () => {
            for await (const event of queue) {
              if (event === null) break
              local.push(JSON.stringify(event))
            }
            local.push(null)
          })()

          try {
            for await (const data of local) {
              if (data === null) return
              await stream.writeSSE({ data })
            }
          } finally {
            stop()
            await pump.catch(() => undefined)
          }
        })
      },
    )
}
