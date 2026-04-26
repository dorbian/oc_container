import { RequestError, type McpServer } from "@agentclientprotocol/sdk"
import type { ACPSessionState } from "./types"
import { Log } from "@/util"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { Global } from "@opencode-ai/core/global"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { ModelID, ProviderID } from "@/provider/schema"

const log = Log.create({ service: "acp-session-manager" })

type StoredSessionState = {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: string
  model?: {
    providerID: string
    modelID: string
  }
  variant?: string
  modeId?: string
}

export class ACPSessionManager {
  private sessions = new Map<string, ACPSessionState>()
  private sdk: OpencodeClient

  constructor(sdk: OpencodeClient) {
    this.sdk = sdk
    this.sessions = this.loadPersisted()
  }

  private storagePath() {
    return process.env.OPENCODE_ACP_SESSION_FILE || path.join(Global.Path.state, "acp-sessions.json")
  }

  private loadPersisted() {
    const target = this.storagePath()
    if (!existsSync(target)) return new Map<string, ACPSessionState>()

    try {
      const raw = JSON.parse(readFileSync(target, "utf-8")) as StoredSessionState[]
      const entries = raw.map((item) => [
        item.id,
        {
          id: item.id,
          cwd: item.cwd,
          mcpServers: item.mcpServers ?? [],
          createdAt: new Date(item.createdAt),
          model: item.model
            ? {
                providerID: ProviderID.make(item.model.providerID),
                modelID: ModelID.make(item.model.modelID),
              }
            : undefined,
          variant: item.variant,
          modeId: item.modeId,
        } satisfies ACPSessionState,
      ] as const)
      return new Map(entries)
    } catch (error) {
      log.error("failed to load persisted ACP sessions", { error, path: target })
      return new Map<string, ACPSessionState>()
    }
  }

  private persist() {
    const target = this.storagePath()
    const payload: StoredSessionState[] = [...this.sessions.values()].map((session) => ({
      id: session.id,
      cwd: session.cwd,
      mcpServers: session.mcpServers,
      createdAt: session.createdAt.toISOString(),
      model: session.model,
      variant: session.variant,
      modeId: session.modeId,
    }))

    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(payload, null, 2))
  }

  tryGet(sessionId: string): ACPSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  async create(cwd: string, mcpServers: McpServer[], model?: ACPSessionState["model"]): Promise<ACPSessionState> {
    const session = await this.sdk.session
      .create(
        {
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((x) => x.data!)

    const sessionId = session.id
    const resolvedModel = model

    const state: ACPSessionState = {
      id: sessionId,
      cwd,
      mcpServers,
      createdAt: new Date(),
      model: resolvedModel,
    }
    log.info("creating_session", { state })

    this.sessions.set(sessionId, state)
    this.persist()
    return state
  }

  async load(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
    model?: ACPSessionState["model"],
  ): Promise<ACPSessionState> {
    const session = await this.sdk.session
      .get(
        {
          sessionID: sessionId,
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((x) => x.data!)

    const resolvedModel = model

    const state: ACPSessionState = {
      id: sessionId,
      cwd,
      mcpServers,
      createdAt: new Date(session.time.created),
      model: resolvedModel,
    }
    log.info("loading_session", { state })

    this.sessions.set(sessionId, state)
    this.persist()
    return state
  }

  get(sessionId: string): ACPSessionState {
    const session = this.sessions.get(sessionId)
    if (!session) {
      log.error("session not found", { sessionId })
      throw RequestError.invalidParams(JSON.stringify({ error: `Session not found: ${sessionId}` }))
    }
    return session
  }

  getModel(sessionId: string) {
    const session = this.get(sessionId)
    return session.model
  }

  setModel(sessionId: string, model: ACPSessionState["model"]) {
    const session = this.get(sessionId)
    session.model = model
    this.sessions.set(sessionId, session)
    this.persist()
    return session
  }

  getVariant(sessionId: string) {
    const session = this.get(sessionId)
    return session.variant
  }

  setVariant(sessionId: string, variant?: string) {
    const session = this.get(sessionId)
    session.variant = variant
    this.sessions.set(sessionId, session)
    this.persist()
    return session
  }

  setMode(sessionId: string, modeId: string) {
    const session = this.get(sessionId)
    session.modeId = modeId
    this.sessions.set(sessionId, session)
    this.persist()
    return session
  }
}
