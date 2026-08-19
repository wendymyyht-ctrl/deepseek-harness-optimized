import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build as bundle } from 'esbuild'
import { Arch, Platform, build as buildElectron } from 'electron-builder'
import { auditReleaseTree } from './audit-release.mjs'
import { stageVendorBinaries } from './vendor-binaries.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = manifest.version
const architecture = 'x64'
const electronVersion = '43.4.0'
const buildRoot = join(root, 'build', `windows-${architecture}`)
const shellRoot = await mkdtemp(join(tmpdir(), 'deepseek-harness-windows-shell-'))
const bundledApp = join(buildRoot, 'app')
const outputRoot = join(root, 'dist', 'windows')
const artifactBase = `DeepSeek-Harness-Optimized-Windows-${architecture}-v${version}`

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
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function cleanProductionInstall(applicationRoot) {
  await removeGeneratedInstallFiles(join(applicationRoot, 'node_modules'))
  await rm(join(applicationRoot, 'profile', 'node_modules', '.bin'), {
    recursive: true,
    force: true,
  })
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

async function findSymbolicLinks(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) found.push(path)
    else if (entry.isDirectory()) await findSymbolicLinks(path, found)
  }
  return found
}

async function stageApplicationCode() {
  await mkdir(join(bundledApp, 'profile'), { recursive: true })
  await mkdir(join(bundledApp, 'scripts'), { recursive: true })
  for (const filename of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await copyFile(join(root, filename), join(bundledApp, filename))
  }
  for (const filename of ['LICENSE', 'NOTICE']) {
    await copyFile(join(root, filename), join(bundledApp, filename))
  }
  for (const filename of [
    'package.json', 'cordis.yml', 'cordis.patch.yml', 'auto-compact-continue.mjs',
    'tool-integrations-local.mjs', 'tool-google-workspace-local.mjs',
  ]) {
    await copyFile(join(root, 'profile', filename), join(bundledApp, 'profile', filename))
  }
  await copyFile(join(root, 'scripts', 'app-server.mjs'), join(bundledApp, 'scripts', 'app-server.mjs'))
  await bundle({
    entryPoints: [join(root, 'profile', 'tool-html-local.mjs')],
    outfile: join(bundledApp, 'profile', 'tool-html-local.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@deepseek-ai/dsh-tools'],
    legalComments: 'eof',
  })
  await bundle({
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
  const path = `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`
  await run('pnpm', [
    '--dir', bundledApp,
    '--config.minimumReleaseAge=0',
    '--config.node-linker=hoisted',
    'install', '--prod', '--frozen-lockfile',
  ], { env: { ...process.env, PATH: path } })
  await stageVendorBinaries({
    targetPlatform: 'win32',
    targetArch: architecture,
    destination: join(bundledApp, 'vendor'),
  })
  await cleanProductionInstall(bundledApp)
  await auditReleaseTree(bundledApp)
  const links = await findSymbolicLinks(bundledApp)
  if (links.length > 0) throw new Error(`Windows staging contains symbolic links: ${links.slice(0, 5).join(', ')}`)
}

async function validateWindowsDependencies() {
  const expected = [
    join(bundledApp, 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64-0.35.3.node'),
    join(bundledApp, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'),
    join(bundledApp, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
  ]
  for (const path of expected) {
    try {
      if ((await stat(path)).size === 0) throw new Error('empty file')
    } catch {
      throw new Error(`Missing Windows x64 runtime dependency: ${path}`)
    }
  }
}

async function stageShell() {
  await mkdir(shellRoot, { recursive: true })
  await copyFile(join(root, 'windows', 'electron-main.cjs'), join(shellRoot, 'electron-main.cjs'))
  await copyFile(join(root, 'windows', 'email-preload.cjs'), join(shellRoot, 'email-preload.cjs'))
  const shellManifest = {
    name: 'deepseek-harness-optimized-windows-shell',
    version,
    private: true,
    main: 'electron-main.cjs',
    description: manifest.description,
    author: 'DeepSeek Harness Optimized contributors',
    license: manifest.license,
  }
  await writeFile(join(shellRoot, 'package.json'), `${JSON.stringify(shellManifest, null, 2)}\n`, 'utf8')
  await writeFile(join(shellRoot, 'package-lock.json'), `${JSON.stringify({
    name: shellManifest.name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: shellManifest.name, version, license: manifest.license } },
  }, null, 2)}\n`, 'utf8')

  // electron-builder asks the detected package manager for an empty production
  // dependency tree even though this shell intentionally has no dependencies.
  // A tiny isolated shim keeps it from discovering the repository workspace.
  const shimDirectory = join(shellRoot, '.build-bin')
  const npmShim = join(shimDirectory, 'npm')
  await mkdir(shimDirectory, { recursive: true })
  await writeFile(
    npmShim,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ name: shellManifest.name, version, dependencies: {} })}'\n`,
    'utf8',
  )
  await chmod(npmShim, 0o755)
}

async function buildPortableExecutable() {
  const originalPath = process.env.PATH
  process.env.PATH = `${join(shellRoot, '.build-bin')}${delimiter}${originalPath || ''}`
  try {
    const artifacts = await buildElectron({
      projectDir: shellRoot,
      targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64),
      config: {
        appId: 'io.github.wendymyyht-ctrl.deepseek-harness-optimized',
        productName: 'DeepSeek Harness Optimized',
        electronVersion,
        compression: 'maximum',
        asar: true,
        npmRebuild: false,
        directories: { output: outputRoot, buildResources: join(root, 'windows') },
        files: ['electron-main.cjs', 'email-preload.cjs', 'package.json'],
        afterPack: async context => {
          const destination = join(context.appOutDir, 'resources', 'app')
          await rm(destination, { recursive: true, force: true })
          await cp(bundledApp, destination, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          })
        },
        win: {
          target: [{ target: 'portable', arch: [architecture] }],
          executableName: 'DeepSeek Harness Optimized',
          icon: join(root, 'windows', 'AppIcon.png'),
          signExecutable: false,
        },
        portable: {
          artifactName: `${artifactBase}.exe`,
          requestExecutionLevel: 'user',
        },
        publish: null,
      },
    })
    const executable = artifacts.find(path => path.endsWith('.exe') && basename(path) === `${artifactBase}.exe`)
    if (!executable) throw new Error(`Portable executable was not produced: ${artifacts.join(', ')}`)
    const packagedDsh = join(
      outputRoot, 'win-unpacked', 'resources', 'app', 'node_modules',
      '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    )
    if ((await stat(packagedDsh)).size === 0) throw new Error('Packaged Harness entrypoint is empty')
    return executable
  } finally {
    process.env.PATH = originalPath
  }
}

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  throw new Error('Cross-building this release is supported from macOS or Linux')
}
try {
  await rm(buildRoot, { recursive: true, force: true })
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await stageApplicationCode()
  await validateWindowsDependencies()
  await stageShell()
  const executable = await buildPortableExecutable()
  const header = await readFile(executable)
  if (header.length < 64 * 1024 * 1024 || header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error('Generated artifact is not a plausible Windows PE executable')
  }
  await writeFile(
    join(outputRoot, 'SHA256SUMS-Windows.txt'),
    `${await sha256(executable)}  ${basename(executable)}\n`,
    'utf8',
  )
  process.stdout.write(`Built ${executable}\n`)
} finally {
  await rm(shellRoot, { recursive: true, force: true })
}
