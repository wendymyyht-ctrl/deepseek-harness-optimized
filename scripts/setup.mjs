import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stageVendorBinaries } from './vendor-binaries.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceProfile = join(repositoryRoot, 'profile')

function runtimeHome() {
  return resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh-optimized'))
}

function profileName() {
  return process.env.DSH_PROFILE?.trim() || 'optimized'
}

export async function installProfile() {
  const home = runtimeHome()
  const name = profileName()
  const profilesDirectory = join(home, 'profiles')
  const destination = join(profilesDirectory, name)
  await mkdir(profilesDirectory, { recursive: true })

  try {
    const info = await lstat(destination)
    if (!info.isSymbolicLink()) {
      throw new Error(`${destination} already exists and is not a link; refusing to overwrite it`)
    }
    const currentTarget = await realpath(destination)
    if (currentTarget !== await realpath(sourceProfile)) {
      throw new Error(`${destination} points to another profile; refusing to replace it`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(sourceProfile, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }

  const vendor = await stageVendorBinaries({
    targetPlatform: platform(),
    targetArch: arch(),
    destination: join(repositoryRoot, 'vendor'),
  })

  return { home, name, destination, vendor }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const installed = await installProfile()
  process.stdout.write(`Profile ready: ${installed.destination}\nRuntime home: ${installed.home}\n`)
  process.stdout.write(`Google Workspace CLI: ${installed.vendor.gws}\nGitHub MCP server: ${installed.vendor.githubMcp}\n`)
}
