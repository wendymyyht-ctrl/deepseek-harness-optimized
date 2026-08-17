import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir, platform as hostPlatform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const GWS_VERSION = '0.22.5'
const GITHUB_MCP_VERSION = '1.9.0'

const ASSETS = {
  'darwin-arm64': [
    {
      id: 'gws',
      archive: 'google-workspace-cli-aarch64-apple-darwin.tar.gz',
      sha256: '1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac',
      url: `https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-aarch64-apple-darwin.tar.gz`,
      executable: 'gws',
      licenseName: 'Google-Workspace-CLI-LICENSE.txt',
    },
    {
      id: 'github-mcp-server',
      archive: 'github-mcp-server_Darwin_arm64.tar.gz',
      sha256: 'cd38785573052942c337805ea365bbc27718e0bd254ee4a48e668a76b3f4a1ce',
      url: `https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}/github-mcp-server_Darwin_arm64.tar.gz`,
      executable: 'github-mcp-server',
      licenseName: 'GitHub-MCP-Server-LICENSE.txt',
    },
  ],
  'win32-x64': [
    {
      id: 'gws',
      archive: 'google-workspace-cli-x86_64-pc-windows-msvc.zip',
      sha256: '407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2',
      url: `https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-x86_64-pc-windows-msvc.zip`,
      executable: 'gws.exe',
      licenseName: 'Google-Workspace-CLI-LICENSE.txt',
    },
    {
      id: 'github-mcp-server',
      archive: 'github-mcp-server_Windows_x86_64.zip',
      sha256: '29e901869c639bb8e7e908496653d37a02d260761c64921fd83a4d9f4fd137f9',
      url: `https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}/github-mcp-server_Windows_x86_64.zip`,
      executable: 'github-mcp-server.exe',
      licenseName: 'GitHub-MCP-Server-LICENSE.txt',
    },
  ],
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with status ${code}`)))
  })
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function cachedArchive(asset, cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true })
  const destination = join(cacheDirectory, asset.archive)
  let valid = false
  try { valid = await sha256(destination) === asset.sha256 } catch {}
  if (valid) return destination

  const temporary = `${destination}.download`
  const response = await fetch(asset.url)
  if (!response.ok || response.body === null) {
    throw new Error(`Unable to download ${asset.id}: HTTP ${response.status}`)
  }
  await pipeline(response.body, createWriteStream(temporary))
  const actual = await sha256(temporary)
  if (actual !== asset.sha256) {
    await rm(temporary, { force: true })
    throw new Error(`${asset.id} checksum mismatch: expected ${asset.sha256}, got ${actual}`)
  }
  await rm(destination, { force: true })
  await copyFile(temporary, destination)
  await rm(temporary, { force: true })
  return destination
}

async function extract(archive, destination) {
  await mkdir(destination, { recursive: true })
  if (archive.endsWith('.tar.gz')) {
    await run('tar', ['-xzf', archive, '-C', destination])
    return
  }
  if (hostPlatform() === 'win32') {
    await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:DSH_VENDOR_ARCHIVE -DestinationPath $env:DSH_VENDOR_DESTINATION -Force',
    ], {
      env: {
        ...process.env,
        DSH_VENDOR_ARCHIVE: archive,
        DSH_VENDOR_DESTINATION: destination,
      },
    })
    return
  }
  await run('unzip', ['-qq', archive, '-d', destination])
}

async function findNamed(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return path
    if (entry.isDirectory()) {
      const nested = await findNamed(path, filename)
      if (nested) return nested
    }
  }
  return undefined
}

export async function stageVendorBinaries({ targetPlatform, targetArch, destination }) {
  const key = `${targetPlatform}-${targetArch}`
  const assets = ASSETS[key]
  if (!assets) throw new Error(`No pinned integration binaries for ${key}`)
  const cacheDirectory = join(homedir(), '.cache', 'deepseek-harness-optimized', 'vendor')
  const binDirectory = join(destination, 'bin')
  const licenseDirectory = join(destination, 'licenses')
  await mkdir(binDirectory, { recursive: true })
  await mkdir(licenseDirectory, { recursive: true })

  for (const asset of assets) {
    const work = await mkdtemp(join(tmpdir(), `dsh-${asset.id}-`))
    try {
      const archive = await cachedArchive(asset, cacheDirectory)
      await extract(archive, work)
      const executable = await findNamed(work, asset.executable)
      const license = await findNamed(work, 'LICENSE')
      if (!executable || !license) throw new Error(`${asset.archive} is missing its executable or LICENSE`)
      const targetExecutable = join(binDirectory, asset.executable)
      await copyFile(executable, targetExecutable)
      await chmod(targetExecutable, 0o755)
      await copyFile(license, join(licenseDirectory, asset.licenseName))
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  return {
    gws: join(binDirectory, targetPlatform === 'win32' ? 'gws.exe' : 'gws'),
    githubMcp: join(binDirectory, targetPlatform === 'win32' ? 'github-mcp-server.exe' : 'github-mcp-server'),
  }
}

export const vendorVersions = { googleWorkspaceCli: GWS_VERSION, githubMcpServer: GITHUB_MCP_VERSION }
