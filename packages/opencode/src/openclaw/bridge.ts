import { createHash, randomBytes } from "node:crypto"
import { spawn as spawnProcess } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { AsyncQueue } from "@/util/queue"

const log = Log.create({ service: "openclaw-bridge" })

const DEFAULT_IMAGE = "opencode-session:local"
const CONTAINER_PORT = 4096
const WORKSPACE_MOUNT_PATH = "/workspace"
const STATE_MOUNT_PATH = "/var/opencode/state"
const DATA_MOUNT_PATH = "/var/opencode/data"
const CONFIG_MOUNT_PATH = "/var/opencode/config"
const RECONNECT_DELAY_MS = 250

export type OpenClawCompactionPolicy = "auto" | "manual"

export type OpenClawBridgeRecord = {
  threadKey: string
  workspacePath: string
  workspaceMountPath: string
  sessionID?: string
  containerID?: string
  containerName: string
  serverUrl?: string
  runtime?: "docker" | "podman"
  image: string
  stateRoot: string
  password: string
  defaultAgent?: string
  allowSubagents?: boolean
  compactionPolicy?: OpenClawCompactionPolicy
  port?: number
  createdAt: string
  updatedAt: string
}

type RegistryFile = {
  version: 1
  sessions: Record<string, OpenClawBridgeRecord>
}

type RelayState = {
  subscribers: Set<AsyncQueue<OpenClawBridgeEvent | null>>
  abort: AbortController
  running?: Promise<void>
}

type RequestOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

export type OpenClawBridgeEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: {
    type: string
    properties?: Record<string, unknown>
  }
}

export type OpenClawEnsureInput = {
  threadKey: string
  workspacePath: string
  title?: string
  image?: string
  agent?: string
  allowSubagents?: boolean
  compactionPolicy?: OpenClawCompactionPolicy
}

export type OpenClawPromptInput = {
  threadKey: string
  workspacePath?: string
  title?: string
  image?: string
  agent?: string
  allowSubagents?: boolean
  compactionPolicy?: OpenClawCompactionPolicy
  prompt: Record<string, unknown>
}

type BridgeDeps = {
  fetch: typeof fetch
  execText: (cmd: string[], opts?: { nothrow?: boolean }) => Promise<{
    code: number
    stdout: Buffer
    stderr: Buffer
    text: string
  }>
  which: (cmd: string) => string | null
  now: () => Date
  registryFile: () => string
  getFreePort: () => Promise<number>
}

function defaultRegistryFile() {
  return process.env.OPENCODE_OPENCLAW_REGISTRY_FILE || path.join(Global.Path.state, "openclaw-bridge.json")
}

function makeDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    fetch: overrides.fetch ?? fetch,
    execText:
      overrides.execText ??
      ((cmd, opts) =>
        new Promise((resolve, reject) => {
          const child = spawnProcess(cmd[0], cmd.slice(1), {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: process.platform === "win32",
          })
          const stdout: Buffer[] = []
          const stderr: Buffer[] = []
          child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
          child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
          child.once("error", reject)
          child.once("close", (code) => {
            const out = Buffer.concat(stdout)
            const err = Buffer.concat(stderr)
            const result = {
              code: code ?? 0,
              stdout: out,
              stderr: err,
              text: out.toString(),
            }
            if ((code ?? 0) === 0 || opts?.nothrow) {
              resolve(result)
              return
            }
            reject(new Error(`Command failed with code ${code}: ${cmd.join(" ")}${err.length ? `\n${err}` : ""}`))
          })
        })),
    which:
      overrides.which ??
      ((cmd) => {
        const pathValue = process.env.PATH ?? process.env.Path ?? ""
        const extensions =
          process.platform === "win32"
            ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM").split(";")
            : [""]
        for (const entry of pathValue.split(path.delimiter)) {
          if (!entry) continue
          for (const ext of extensions) {
            const candidate = path.join(entry, process.platform === "win32" && !cmd.includes(".") ? `${cmd}${ext}` : cmd)
            if (existsSync(candidate)) return candidate
          }
        }
        return null
      }),
    now: overrides.now ?? (() => new Date()),
    registryFile: overrides.registryFile ?? defaultRegistryFile,
    getFreePort:
      overrides.getFreePort ??
      (() =>
        new Promise<number>((resolve, reject) => {
          const server = createServer()
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (!address || typeof address === "string") {
              server.close()
              reject(new Error("Failed to allocate bridge port"))
              return
            }
            const port = address.port
            server.close((error) => {
              if (error) reject(error)
              else resolve(port)
            })
          })
        })),
  }
}

function sanitizeName(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "thread"
}

function registryHash(threadKey: string) {
  return createHash("sha256").update(threadKey).digest("hex").slice(0, 12)
}

function nowIso(deps: BridgeDeps) {
  return deps.now().toISOString()
}

function sessionIDForEvent(event: OpenClawBridgeEvent) {
  const props = event.payload?.properties
  if (!props) return
  if (typeof props.sessionID === "string") return props.sessionID
  const part = props.part
  if (part && typeof part === "object" && "sessionID" in part && typeof part.sessionID === "string") return part.sessionID
  const message = props.message
  if (message && typeof message === "object" && "sessionID" in message && typeof message.sessionID === "string")
    return message.sessionID
}

function basicAuth(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function buildContainerConfig(record: OpenClawBridgeRecord) {
  return {
    ...(record.compactionPolicy
      ? {
          compaction: {
            auto: record.compactionPolicy === "auto",
          },
        }
      : {}),
  }
}

function appendSystem(base: unknown, addition: string) {
  if (typeof base === "string" && base.trim()) return `${base}\n\n${addition}`
  return addition
}

function mergePrompt(record: OpenClawBridgeRecord, input: OpenClawPromptInput) {
  const prompt = structuredClone(input.prompt)
  const agent = input.agent ?? record.defaultAgent
  if (agent) prompt.agent = agent

  const allowSubagents = input.allowSubagents ?? record.allowSubagents
  if (allowSubagents === false) {
    const tools =
      prompt.tools && typeof prompt.tools === "object" && !Array.isArray(prompt.tools)
        ? { ...(prompt.tools as Record<string, unknown>) }
        : {}
    tools.task = false
    prompt.tools = tools
    prompt.system = appendSystem(
      prompt.system,
      "Do not spawn or delegate work to subagents. Complete the task in this session only.",
    )
  }

  return prompt
}

async function parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  async function* iterate(): AsyncGenerator<OpenClawBridgeEvent> {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary === -1) break
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        yield JSON.parse(data) as OpenClawBridgeEvent
      }
    }
  }

  return iterate()
}

export class OpenClawBridge {
  private registry?: RegistryFile
  private writes = Promise.resolve()
  private relays = new Map<string, RelayState>()

  constructor(private readonly deps: BridgeDeps = makeDeps()) {}

  private async loadRegistry() {
    if (this.registry) return this.registry
    const file = this.deps.registryFile()
    if (!existsSync(file)) {
      this.registry = { version: 1, sessions: {} }
      return this.registry
    }
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RegistryFile>
      this.registry = {
        version: 1,
        sessions: parsed.sessions ?? {},
      }
      return this.registry
    } catch (error) {
      log.error("failed to load openclaw registry", { file, error })
      this.registry = { version: 1, sessions: {} }
      return this.registry
    }
  }

  private async persistRegistry() {
    const registry = await this.loadRegistry()
    const file = this.deps.registryFile()
    await mkdir(path.dirname(file), { recursive: true })
    this.writes = this.writes.then(() => writeFile(file, JSON.stringify(registry, null, 2)))
    await this.writes
  }

  private async setRecord(record: OpenClawBridgeRecord) {
    const registry = await this.loadRegistry()
    registry.sessions[record.threadKey] = record
    await this.persistRegistry()
    return record
  }

  private async deleteRecord(threadKey: string) {
    const registry = await this.loadRegistry()
    delete registry.sessions[threadKey]
    await this.persistRegistry()
  }

  async get(threadKey: string) {
    const registry = await this.loadRegistry()
    return registry.sessions[threadKey]
  }

  async list() {
    const registry = await this.loadRegistry()
    return Object.values(registry.sessions)
  }

  private resolveRuntime(existing?: OpenClawBridgeRecord["runtime"]) {
    const explicit = process.env.OPENCODE_OPENCLAW_CONTAINER_RUNTIME
    if (explicit === "docker" || explicit === "podman") return explicit
    if (existing) return existing
    if (this.deps.which("podman")) return "podman" as const
    if (this.deps.which("docker")) return "docker" as const
    throw new Error("No container runtime found. Install podman or docker, or set OPENCODE_OPENCLAW_CONTAINER_RUNTIME.")
  }

  private async request<T>(record: OpenClawBridgeRecord, pathname: string, opts: RequestOptions = {}) {
    if (!record.serverUrl) throw new Error(`Thread "${record.threadKey}" does not have a server URL`)
    const response = await this.deps.fetch(new URL(pathname, record.serverUrl), {
      method: opts.method ?? "GET",
      headers: {
        authorization: basicAuth(record.password),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Bridge request failed (${response.status}) ${pathname}${detail ? `: ${detail}` : ""}`)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private async checkHealth(record: OpenClawBridgeRecord) {
    if (!record.serverUrl) return false
    try {
      const response = await this.deps.fetch(new URL("/global/health", record.serverUrl), {
        headers: {
          authorization: basicAuth(record.password),
        },
        signal: AbortSignal.timeout(3_000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  private async ensureContainer(record: OpenClawBridgeRecord) {
    if (await this.checkHealth(record)) return record

    const runtime = this.resolveRuntime(record.runtime)
    const port = await this.deps.getFreePort()
    const stateRoot = record.stateRoot
    const serverUrl = `http://127.0.0.1:${port}`
    await mkdir(path.join(stateRoot, "state"), { recursive: true })
    await mkdir(path.join(stateRoot, "data"), { recursive: true })
    await mkdir(path.join(stateRoot, "config"), { recursive: true })
    await writeFile(path.join(stateRoot, "config", "opencode.json"), JSON.stringify(buildContainerConfig(record), null, 2))

    await this.deps.execText([runtime, "rm", "-f", record.containerName], { nothrow: true })

    const args = [
      runtime,
      "run",
      "-d",
      "--init",
      "--name",
      record.containerName,
      "-p",
      `127.0.0.1:${port}:${CONTAINER_PORT}`,
      "-w",
      WORKSPACE_MOUNT_PATH,
      "-e",
      "OPENCODE_SERVER_USERNAME=opencode",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${record.password}`,
      "-e",
      `XDG_STATE_HOME=${STATE_MOUNT_PATH}`,
      "-e",
      `XDG_DATA_HOME=${DATA_MOUNT_PATH}`,
      "-e",
      `XDG_CONFIG_HOME=${CONFIG_MOUNT_PATH}`,
      "-v",
      `${record.workspacePath}:${WORKSPACE_MOUNT_PATH}`,
      "-v",
      `${path.join(stateRoot, "state")}:${STATE_MOUNT_PATH}`,
      "-v",
      `${path.join(stateRoot, "data")}:${DATA_MOUNT_PATH}`,
      "-v",
      `${path.join(stateRoot, "config")}:${CONFIG_MOUNT_PATH}`,
      record.image,
      "serve",
      "--hostname",
      "0.0.0.0",
      "--port",
      String(CONTAINER_PORT),
    ]

    const containerID = (await this.deps.execText(args)).text.trim()
    const next: OpenClawBridgeRecord = {
      ...record,
      runtime,
      port,
      serverUrl,
      containerID: containerID || record.containerID,
      updatedAt: nowIso(this.deps),
    }

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await this.checkHealth(next)) {
        await this.setRecord(next)
        return next
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    throw new Error(`OpenClaw bridge container for thread "${record.threadKey}" failed health check`)
  }

  private async ensureSession(record: OpenClawBridgeRecord, title?: string) {
    const alive = await this.ensureContainer(record)

    if (alive.sessionID) {
      try {
        await this.request(alive, `/session/${alive.sessionID}`)
        return alive
      } catch {
        log.warn("stored openclaw session missing, creating replacement", {
          threadKey: alive.threadKey,
          sessionID: alive.sessionID,
        })
      }
    }

    const created = await this.request<{ id: string }>(alive, "/session", {
      method: "POST",
      body: {
        title: title ?? `OpenClaw ${alive.threadKey}`,
      },
    })

    const next = {
      ...alive,
      sessionID: created.id,
      updatedAt: nowIso(this.deps),
    }
    await this.setRecord(next)
    return next
  }

  async ensureThread(input: OpenClawEnsureInput) {
    const current = await this.get(input.threadKey)
    const hash = registryHash(input.threadKey)
    const createdAt = current?.createdAt ?? nowIso(this.deps)
    const image = input.image ?? current?.image ?? process.env.OPENCODE_OPENCLAW_IMAGE ?? DEFAULT_IMAGE
    const defaultAgent = input.agent ?? current?.defaultAgent
    const allowSubagents = input.allowSubagents ?? current?.allowSubagents
    const compactionPolicy = input.compactionPolicy ?? current?.compactionPolicy
    const requiresRestart =
      current?.image !== undefined &&
      (current.image !== image || current.compactionPolicy !== compactionPolicy)
    const next: OpenClawBridgeRecord = {
      threadKey: input.threadKey,
      workspacePath: input.workspacePath,
      workspaceMountPath: WORKSPACE_MOUNT_PATH,
      sessionID: current?.sessionID,
      containerID: requiresRestart ? undefined : current?.containerID,
      containerName: current?.containerName ?? `opencode-openclaw-${sanitizeName(input.threadKey)}-${hash}`,
      serverUrl: requiresRestart ? undefined : current?.serverUrl,
      runtime: current?.runtime,
      image,
      stateRoot: current?.stateRoot ?? path.join(Global.Path.state, "openclaw", hash),
      password: current?.password ?? randomBytes(18).toString("base64url"),
      defaultAgent,
      allowSubagents,
      compactionPolicy,
      port: requiresRestart ? undefined : current?.port,
      createdAt,
      updatedAt: nowIso(this.deps),
    }
    return await this.ensureSession(await this.setRecord(next), input.title)
  }

  async promptAsync(input: OpenClawPromptInput) {
    const existing = await this.get(input.threadKey)
    if (!existing && !input.workspacePath) {
      throw new Error(`Thread "${input.threadKey}" has no registry entry; workspacePath is required`)
    }
    const record = await this.ensureThread({
      threadKey: input.threadKey,
      workspacePath: input.workspacePath ?? existing!.workspacePath,
      title: input.title,
      image: input.image,
      agent: input.agent,
      allowSubagents: input.allowSubagents,
      compactionPolicy: input.compactionPolicy,
    })
    if (!record.sessionID) throw new Error(`Thread "${input.threadKey}" does not have a session`)
    await this.request(record, `/session/${record.sessionID}/prompt_async`, {
      method: "POST",
      body: mergePrompt(record, input),
    })
    return record
  }

  async abort(threadKey: string) {
    const record = await this.get(threadKey)
    if (!record?.sessionID) throw new Error(`Thread "${threadKey}" is not registered`)
    await this.request(record, `/session/${record.sessionID}/abort`, {
      method: "POST",
    })
    return true
  }

  async messages(threadKey: string, query?: { limit?: number; before?: string }) {
    const record = await this.get(threadKey)
    if (!record?.sessionID) throw new Error(`Thread "${threadKey}" is not registered`)
    const params = new URLSearchParams()
    if (query?.limit !== undefined) params.set("limit", String(query.limit))
    if (query?.before) params.set("before", query.before)
    const pathname = `/session/${record.sessionID}/message${params.size ? `?${params.toString()}` : ""}`
    return await this.request<unknown[]>(record, pathname)
  }

  async dispose(threadKey: string) {
    const record = await this.get(threadKey)
    if (!record) return false

    const relay = this.relays.get(threadKey)
    if (relay) {
      relay.abort.abort()
      for (const subscriber of relay.subscribers) subscriber.push(null)
      this.relays.delete(threadKey)
    }

    const runtime = this.resolveRuntime(record.runtime)
    await this.deps.execText([runtime, "rm", "-f", record.containerName], { nothrow: true })
    await this.deleteRecord(threadKey)
    return true
  }

  private async runRelay(threadKey: string, relay: RelayState) {
    while (!relay.abort.signal.aborted && relay.subscribers.size > 0) {
      const record = await this.get(threadKey)
      if (!record?.sessionID) break
      const ready = await this.ensureThread({
        threadKey,
        workspacePath: record.workspacePath,
        image: record.image,
      })

      try {
        const response = await this.deps.fetch(new URL("/global/event", ready.serverUrl!), {
          headers: {
            authorization: basicAuth(ready.password),
          },
          signal: relay.abort.signal,
        })
        if (!response.ok || !response.body) throw new Error(`Bridge event stream failed with ${response.status}`)
        const events = await parseSSE(response.body, relay.abort.signal)
        for await (const event of events) {
          if (relay.abort.signal.aborted) return
          const sessionID = sessionIDForEvent(event)
          if (sessionID && sessionID !== ready.sessionID) continue
          for (const subscriber of relay.subscribers) subscriber.push(event)
        }
      } catch (error) {
        if (relay.abort.signal.aborted) return
        log.warn("openclaw event relay reconnecting", { threadKey, error })
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
      }
    }
  }

  async subscribe(threadKey: string) {
    const record = await this.get(threadKey)
    if (!record?.sessionID) throw new Error(`Thread "${threadKey}" is not registered`)

    const queue = new AsyncQueue<OpenClawBridgeEvent | null>()
    let relay = this.relays.get(threadKey)
    if (!relay) {
      relay = {
        subscribers: new Set(),
        abort: new AbortController(),
      }
      this.relays.set(threadKey, relay)
    }
    relay.subscribers.add(queue)
    if (!relay.running) {
      relay.running = this.runRelay(threadKey, relay).finally(() => {
        if (this.relays.get(threadKey) === relay) this.relays.delete(threadKey)
      })
    }

    return {
      queue,
      unsubscribe: () => {
        const current = this.relays.get(threadKey)
        if (!current) return
        current.subscribers.delete(queue)
        queue.push(null)
        if (current.subscribers.size === 0) {
          current.abort.abort()
          this.relays.delete(threadKey)
        }
      },
    }
  }
}

let singleton: OpenClawBridge | undefined

export const OpenClawBridgeService = {
  create(overrides?: Partial<BridgeDeps>) {
    return new OpenClawBridge(makeDeps(overrides))
  },
  default() {
    singleton ??= new OpenClawBridge()
    return singleton
  },
}
