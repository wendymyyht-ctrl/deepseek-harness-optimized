# Windows desktop build

`npm run build:windows` cross-builds a Windows x64 Portable EXE. The artifact
contains Electron, the Harness server, production dependencies, and this
repository's managed profile. The user does not need a separate Node.js install.
The 1.3.0 build uses the same blue-whale icon and application version as macOS,
and bundles the pinned Google Workspace CLI and official GitHub MCP Server.
It also includes the pinned Vision Toolkit integration; no vision credential or
private provider configuration is embedded in the executable.

Runtime data is stored under `%APPDATA%\DeepSeek Harness Optimized`. The build
contains no model weights, API credentials, conversations, or personal memory.
QQ/NetEase authorization codes entered through the app menu are encrypted with
Windows DPAPI for the current user and are created only after installation.

The community EXE is currently unsigned. Windows SmartScreen may show an
unknown-publisher warning; publishing without that warning requires a trusted
Windows code-signing certificate.
