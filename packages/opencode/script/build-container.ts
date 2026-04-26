#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
process.chdir(root)

const runtime = process.env.OPENCODE_OPENCLAW_CONTAINER_RUNTIME ?? "docker"
const image = process.env.OPENCODE_OPENCLAW_IMAGE ?? "opencode-session:local"
const skipBuild = process.argv.includes("--skip-build")

if (!skipBuild) {
  console.log("Building OpenCode binaries for the container image")
  await $`bun run build`
}

const dockerfile = path.join(root, "Dockerfile")
console.log(`Building ${image} with ${runtime}`)
await $`${runtime} build -f ${dockerfile} -t ${image} .`
