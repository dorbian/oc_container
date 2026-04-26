import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { OpenClawBridgeService, type OpenClawBridgeEvent } from "../../src/openclaw/bridge"

function streamFromEvents(events: OpenClawBridgeEvent[]) {
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

describe("openclaw bridge", () => {
  let tempRoot = ""

  afterEach(async () => {
    tempRoot = ""
  })

  test("reuses persisted thread session metadata across bridge instances", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-"))
    const registryFile = path.join(tempRoot, "registry.json")
    const sessionID = "session-reused"
    await writeFile(
      registryFile,
      JSON.stringify({
        version: 1,
        sessions: {
          "thread-1": {
            threadKey: "thread-1",
            workspacePath: "/repo",
            workspaceMountPath: "/workspace",
            sessionID,
            containerID: "container-1",
            containerName: "container-1",
            serverUrl: "http://127.0.0.1:4101",
            runtime: "docker",
            image: "opencode-session:local",
            stateRoot: path.join(tempRoot, "state"),
            password: "secret",
            port: 4101,
            createdAt: "2026-04-26T10:00:00.000Z",
            updatedAt: "2026-04-26T10:00:00.000Z",
          },
        },
      }),
    )

    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url.endsWith("/global/health")) return new Response(JSON.stringify({ healthy: true }), { status: 200 })
      if (url.endsWith(`/session/${sessionID}`)) return new Response(JSON.stringify({ id: sessionID }), { status: 200 })
      throw new Error(`Unexpected fetch ${url}`)
    }) as typeof fetch

    const registry = JSON.parse(await readFile(registryFile, "utf8")) as { sessions: Record<string, { sessionID: string }> }
    expect(registry.sessions["thread-1"]?.sessionID).toBe(sessionID)

    const bridge2 = OpenClawBridgeService.create({
      fetch: fetchImpl,
      registryFile: () => registryFile,
      execText: async () => {
        throw new Error("container launch should not be needed")
      },
      which: (cmd) => (cmd === "docker" ? "docker" : null),
      now: () => new Date("2026-04-26T10:01:00.000Z"),
      getFreePort: async () => 4102,
    })

    const reused = await bridge2.ensureThread({
      threadKey: "thread-1",
      workspacePath: "/repo",
    })

    expect(reused.sessionID).toBe(sessionID)
  })

  test("promptAsync launches a container, creates a session, and forwards abort", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-"))
    const registryFile = path.join(tempRoot, "registry.json")
    const calls: Array<{ url: string; method: string }> = []
    const sessionID = "session-123"

    const bridge = OpenClawBridgeService.create({
      registryFile: () => registryFile,
      which: (cmd) => (cmd === "docker" ? "docker" : null),
      now: () => new Date("2026-04-26T10:00:00.000Z"),
      getFreePort: async () => 4110,
      execText: async (cmd) => {
        expect(cmd.slice(0, 3)).toEqual(["docker", "run", "-d"])
        return { code: 0, stdout: Buffer.from("container-123"), stderr: Buffer.alloc(0), text: "container-123" }
      },
      fetch: (async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
        const url = String(input)
        const method = init?.method ?? "GET"
        calls.push({ url, method })
        if (url.endsWith("/global/health")) return new Response(JSON.stringify({ healthy: true }), { status: 200 })
        if (url.endsWith(`/session/${sessionID}`)) return new Response("missing", { status: 404 })
        if (url.endsWith("/session") && method === "POST") return new Response(JSON.stringify({ id: sessionID }), { status: 200 })
        if (url.endsWith(`/session/${sessionID}/prompt_async`) && method === "POST") return new Response(null, { status: 204 })
        if (url.endsWith(`/session/${sessionID}/abort`) && method === "POST") return new Response(JSON.stringify(true), { status: 200 })
        throw new Error(`Unexpected fetch ${url}`)
      }) as typeof fetch,
    })

    const record = await bridge.promptAsync({
      threadKey: "thread-2",
      workspacePath: "/repo",
      prompt: {
        parts: [{ type: "text", id: "part-1", text: "hello" }],
      },
    })

    expect(record.sessionID).toBe(sessionID)
    expect(calls.some((item) => item.url.endsWith("/session") && item.method === "POST")).toBe(true)
    expect(calls.some((item) => item.url.endsWith(`/session/${sessionID}/prompt_async`) && item.method === "POST")).toBe(
      true,
    )

    await bridge.abort("thread-2")
    expect(calls.some((item) => item.url.endsWith(`/session/${sessionID}/abort`) && item.method === "POST")).toBe(true)
  })

  test("subscribes to one child SSE stream and forwards only matching session events", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-"))
    const registryFile = path.join(tempRoot, "registry.json")
    const sessionID = "session-stream"
    let eventFetches = 0

    await writeFile(
      registryFile,
      JSON.stringify({
        version: 1,
        sessions: {
          "thread-3": {
            threadKey: "thread-3",
            workspacePath: "/repo",
            workspaceMountPath: "/workspace",
            sessionID,
            containerID: "container-stream",
            containerName: "container-stream",
            serverUrl: "http://127.0.0.1:4120",
            runtime: "docker",
            image: "opencode-session:local",
            stateRoot: path.join(tempRoot, "state"),
            password: "secret",
            port: 4120,
            createdAt: "2026-04-26T10:00:00.000Z",
            updatedAt: "2026-04-26T10:00:00.000Z",
          },
        },
      }),
    )

    const bridge = OpenClawBridgeService.create({
      registryFile: () => registryFile,
      which: (cmd) => (cmd === "docker" ? "docker" : null),
      now: () => new Date("2026-04-26T10:00:00.000Z"),
      getFreePort: async () => 4120,
      execText: async () => ({ code: 0, stdout: Buffer.from("container-stream"), stderr: Buffer.alloc(0), text: "container-stream" }),
      fetch: (async (input: URL | RequestInfo) => {
        const url = String(input)
        if (url.endsWith("/global/health")) return new Response(JSON.stringify({ healthy: true }), { status: 200 })
        if (url.endsWith(`/session/${sessionID}`)) return new Response(JSON.stringify({ id: sessionID }), { status: 200 })
        if (url.endsWith("/global/event")) {
          eventFetches += 1
          return new Response(
            streamFromEvents([
              {
                payload: {
                  type: "message.part.delta",
                  properties: {
                    sessionID,
                    messageID: "msg-1",
                    partID: "part-1",
                    field: "text",
                    delta: "hel",
                  },
                },
              },
              {
                payload: {
                  type: "message.part.delta",
                  properties: {
                    sessionID: "other-session",
                    messageID: "msg-2",
                    partID: "part-2",
                    field: "text",
                    delta: "skip",
                  },
                },
              },
              {
                payload: {
                  type: "session.idle",
                  properties: {
                    sessionID,
                  },
                },
              },
            ]),
            { status: 200 },
          )
        }
        throw new Error(`Unexpected fetch ${url}`)
      }) as typeof fetch,
    })

    const first = await bridge.subscribe("thread-3")
    const second = await bridge.subscribe("thread-3")

    const events1: string[] = []
    const events2: string[] = []

    for (let i = 0; i < 2; i++) {
      const event = await first.queue.next()
      if (event) events1.push(event.payload.type)
    }
    for (let i = 0; i < 2; i++) {
      const event = await second.queue.next()
      if (event) events2.push(event.payload.type)
    }

    first.unsubscribe()
    second.unsubscribe()

    expect(events1).toEqual(["message.part.delta", "session.idle"])
    expect(events2).toEqual(["message.part.delta", "session.idle"])
    expect(eventFetches).toBe(1)
  })
})
