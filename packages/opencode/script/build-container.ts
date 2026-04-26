#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
process.chdir(root)

const runtime = process.env.OPENCODE_OPENCLAW_CONTAINER_RUNTIME ?? "docker"
const registry = process.env.REGISTRY?.replace(/\/+$/, "")
const tag = process.env.TAG ?? "local"
const defaultImage = registry ? `${registry}/opencode-session:${tag}` : `opencode-session:${tag}`
const image = process.env.OPENCODE_OPENCLAW_IMAGE ?? defaultImage
const skipBuild = process.argv.includes("--skip-build")
const push = process.argv.includes("--push") || process.env.PUSH === "1"
const platform = process.env.PLATFORM ?? "linux/amd64,linux/arm64"

if (!skipBuild) {
  console.log("Building OpenCode binaries for the container image")
  await $`bun run build`
}

const dockerfile = path.join(root, "Dockerfile")
console.log(`Building ${image} with ${runtime}`)

if (push) {
  console.log(`Pushing multi-arch image for ${platform}`)
  await $`${runtime} buildx build --platform ${platform} -f ${dockerfile} -t ${image} --push .`
} else {
  await $`${runtime} build -f ${dockerfile} -t ${image} .`
}
