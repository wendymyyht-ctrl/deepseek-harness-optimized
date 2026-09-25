import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { auditReleaseTree } from './audit-release.mjs'
import { stageVendorBinaries } from './vendor-binaries.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = manifest.version
const architecture = 'arm64'
const minimumMacOS = '13.0'
const nodeVersion = '24.19.0'
const nodeArchive = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`
const nodeSha256 = '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d'
const buildRoot = join(root, 'build', 'macos-arm64')
const outputRoot = join(root, 'dist', 'macos')
const appName = 'DeepSeek Harness Optimized'
const appBundle = join(buildRoot, `${appName}.app`)
const contents = join(appBundle, 'Contents')
const resources = join(contents, 'Resources')
const bundledApp = join(resources, 'app')
const cacheRoot = join(homedir(), 'Library', 'Caches', 'deepseek-harness-optimized-builder')

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with status ${code}`))
    })
  })
}

async function sha256(path) {
  const hash = createHash('sha256')
  const data = await readFile(path)
  hash.update(data)
  return hash.digest('hex')
}

async function downloadNode() {
  await mkdir(cacheRoot, { recursive: true })
  const archivePath = join(cacheRoot, nodeArchive)
  let valid = false
  try { valid = await sha256(archivePath) === nodeSha256 } catch {}
  if (!valid) {
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`)
    if (!response.ok || response.body === null) {
      throw new Error(`Node.js download failed: HTTP ${response.status}`)
    }
    const temporary = `${archivePath}.download`
    await pipeline(response.body, createWriteStream(temporary))
    if (await sha256(temporary) !== nodeSha256) throw new Error('Node.js archive checksum mismatch')
    await rm(archivePath, { force: true })
    await copyFile(temporary, archivePath)
    await rm(temporary, { force: true })
  }
  return archivePath
}

async function createIcon() {
  const iconWork = join(buildRoot, 'icon')
  const iconset = join(iconWork, 'AppIcon.iconset')
  const master = join(iconWork, 'master.png')
  await mkdir(iconset, { recursive: true })
  await copyFile(join(root, 'macos', 'AppIcon.png'), master)
  const sizes = new Map([
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ])
  for (const [filename, size] of sizes) {
    await run('sips', ['-z', String(size), String(size), master, '--out', join(iconset, filename)])
  }
  await run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'AppIcon.icns')])
}

async function stageApplicationCode() {
  await mkdir(join(bundledApp, 'profile'), { recursive: true })
  await mkdir(join(bundledApp, 'scripts'), { recursive: true })
  for (const filename of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await copyFile(join(root, filename), join(bundledApp, filename))
  }
  for (const filename of [
    'package.json', 'cordis.yml', 'cordis.patch.yml', 'auto-compact-continue.mjs',
    'tool-integrations-local.mjs', 'tool-google-workspace-local.mjs',
    'tool-memory-local.mjs', 'tool-document-local.mjs', 'tool-media-local.mjs',
  'tool-automation-local.mjs', 'automation-core-local.mjs', 'automation-runner-local.mjs', 'web-search-public.mjs',
  ]) {
    await copyFile(join(root, 'profile', filename), join(bundledApp, 'profile', filename))
  }
  await copyFile(join(root, 'scripts', 'patch-vision.mjs'), join(bundledApp, 'scripts', 'patch-vision.mjs'))
  await copyFile(join(root, 'scripts', 'app-server.mjs'), join(bundledApp, 'scripts', 'app-server.mjs'))
  await build({
    entryPoints: [join(root, 'profile', 'tool-html-local.mjs')],
    outfile: join(bundledApp, 'profile', 'tool-html-local.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@deepseek-ai/dsh-tools'],
    legalComments: 'eof',
  })
  await build({
    entryPoints: [join(root, 'profile', 'tool-email-local.mjs')],
    outfile: join(bundledApp, 'profile', 'tool-email-local.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@deepseek-ai/dsh-tools'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    legalComments: 'eof',
  })
  await run('pnpm', ['--config.minimumReleaseAge=0', 'install', '--prod', '--frozen-lockfile'], {
    cwd: bundledApp,
    env: { ...process.env, npm_config_arch: architecture },
  })
  await stageVendorBinaries({
    targetPlatform: 'darwin',
    targetArch: architecture,
    destination: join(bundledApp, 'vendor'),
  })
  await cleanProductionInstall(bundledApp)
  await auditReleaseTree(bundledApp)
}

async function cleanProductionInstall(applicationRoot) {
  // Package-manager metadata and command shims capture the build machine's
  // absolute path and are unnecessary because launchers use package entries.
  await removeGeneratedInstallFiles(join(applicationRoot, 'node_modules'))
  await rm(join(applicationRoot, 'profile', 'node_modules', '.bin'), {
    recursive: true,
    force: true,
  })
  // imapflow publishes its upstream TLS fixture key. It is not a user secret
  // and is never used at runtime, so production artifacts should omit it.
  await rm(join(applicationRoot, 'profile', 'node_modules', 'imapflow', 'test'), {
    recursive: true,
    force: true,
  })
}

async function removeGeneratedInstallFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.name === '.bin' || entry.name === '.modules.yaml' || entry.name === '.pnpm-workspace-state-v1.json') {
      await rm(path, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await removeGeneratedInstallFiles(path)
    }
  }
}

async function stageNodeRuntime(archivePath) {
  const extractRoot = join(buildRoot, 'node-extract')
  await mkdir(extractRoot, { recursive: true })
  await run('tar', ['-xzf', archivePath, '-C', extractRoot])
  const nodeRoot = join(extractRoot, `node-v${nodeVersion}-darwin-${architecture}`)
  await mkdir(join(resources, 'runtime', 'bin'), { recursive: true })
  await mkdir(join(resources, 'ThirdPartyLicenses'), { recursive: true })
  await copyFile(join(nodeRoot, 'bin', 'node'), join(resources, 'runtime', 'bin', 'node'))
  await chmod(join(resources, 'runtime', 'bin', 'node'), 0o755)
  await copyFile(join(nodeRoot, 'LICENSE'), join(resources, 'ThirdPartyLicenses', 'Node-LICENSE.txt'))
  await copyFile(join(root, 'LICENSE'), join(resources, 'LICENSE.txt'))
  await copyFile(join(root, 'NOTICE'), join(resources, 'NOTICE.txt'))
}

async function compileLauncher() {
  await run('xcrun', [
    'swiftc', '-O', '-swift-version', '5',
    '-target', `${architecture}-apple-macos${minimumMacOS}`,
    '-framework', 'Cocoa', '-framework', 'WebKit',
    join(root, 'macos', 'HarnessOptimized.swift'),
    '-o', join(contents, 'MacOS', 'HarnessOptimized'),
  ])
}

async function createArtifacts() {
  await mkdir(outputRoot, { recursive: true })
  const artifactBase = `DeepSeek-Harness-Optimized-macOS-${architecture}-v${version}`
  const zipPath = join(outputRoot, `${artifactBase}.zip`)
  const dmgPath = join(outputRoot, `${artifactBase}.dmg`)
  const dmgSource = join(buildRoot, 'dmg')
  await rm(zipPath, { force: true })
  await rm(dmgPath, { force: true })
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, zipPath])
  await mkdir(dmgSource, { recursive: true })
  await cp(appBundle, join(dmgSource, basename(appBundle)), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  })
  await symlink('/Applications', join(dmgSource, 'Applications'))
  await run('hdiutil', [
    'create', '-volname', appName, '-srcfolder', dmgSource,
    '-ov', '-format', 'UDZO', dmgPath,
  ])
  const lines = []
  for (const path of [zipPath, dmgPath]) lines.push(`${await sha256(path)}  ${basename(path)}`)
  await writeFile(join(outputRoot, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
  return { zipPath, dmgPath }
}

if (process.platform !== 'darwin' || process.arch !== architecture) {
  throw new Error(`This release build must run on macOS ${architecture}`)
}
await rm(buildRoot, { recursive: true, force: true })
await mkdir(join(contents, 'MacOS'), { recursive: true })
await mkdir(resources, { recursive: true })
const info = (await readFile(join(root, 'macos', 'Info.plist'), 'utf8'))
  .replaceAll('__VERSION__', version)
  .replaceAll('__BUILD__', version.replace(/\D/gu, '') || '1')
await writeFile(join(contents, 'Info.plist'), info, 'utf8')
await stageApplicationCode()
await stageNodeRuntime(await downloadNode())
await createIcon()
await compileLauncher()
await run('codesign', ['--force', '--deep', '--sign', '-', appBundle])
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle])
const artifacts = await createArtifacts()
process.stdout.write(`Built ${appBundle}\n${artifacts.zipPath}\n${artifacts.dmgPath}\n`)
