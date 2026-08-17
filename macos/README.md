# macOS application

The macOS wrapper is a small native AppKit/WebKit launcher. It starts the bundled Node.js runtime and the same DeepSeek Harness Web profile, then displays the loopback-only Web UI inside a native window.

The release build currently targets Apple Silicon and macOS 13 or newer. It is ad-hoc signed because this community project has no Apple Developer signing identity; it is not notarized.

## Build

Install the workspace dependencies, then run:

```bash
pnpm install
pnpm run build:macos
```

The build downloads the pinned Node.js, Google Workspace CLI and GitHub MCP Server archives, verifies their SHA-256 checksums, installs only production dependencies inside the app, bundles the HTML and email tools, compiles the native launcher, applies an ad-hoc signature, and creates ZIP and DMG artifacts under `dist/macos`. The icon is generated from the same blue-whale PNG used by the Windows build.

Runtime credentials, settings and sessions live under `~/Library/Application Support/DeepSeek Harness Optimized`. Email authorization codes are stored in macOS Keychain through the app menu. The application bundle contains no user data or credentials.
