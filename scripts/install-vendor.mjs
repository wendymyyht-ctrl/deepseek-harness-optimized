import { mkdir } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageVendorBinaries } from './vendor-binaries.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'vendor')
await mkdir(destination, { recursive: true })
const result = await stageVendorBinaries({ targetPlatform: platform(), targetArch: arch(), destination })
process.stdout.write(`Installed Google Workspace CLI: ${result.gws}\nInstalled GitHub MCP server: ${result.githubMcp}\n`)
