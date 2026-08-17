# macOS application

The macOS wrapper is a small native AppKit/WebKit launcher. It starts the bundled Node.js runtime and the same DeepSeek Harness Web profile, then displays the loopback-only Web UI inside a native window.

The release build currently targets Apple Silicon and macOS 13 or newer. It is ad-hoc signed because this community project has no Apple Developer signing identity; it is not notarized.

## Build

Install the workspace dependencies, then run:

```bash
pnpm install
pnpm run build:macos
```

The build downloads the pinned official Node.js macOS archive, verifies its SHA-256 checksum, installs only production dependencies inside the app, bundles the HTML parser, compiles the native launcher, applies an ad-hoc signature, and creates ZIP and DMG artifacts under `dist/macos`.

Runtime credentials, settings and sessions live under `~/Library/Application Support/DeepSeek Harness Optimized`. The application bundle contains no user data or credentials.
