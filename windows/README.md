# Windows desktop build

`npm run build:windows` cross-builds a Windows x64 Portable EXE. The artifact
contains Electron, the Harness server, production dependencies, and this
repository's managed profile. The user does not need a separate Node.js install.

Runtime data is stored under `%APPDATA%\DeepSeek Harness Optimized`. The build
contains no model weights, API credentials, conversations, or personal memory.

The community EXE is currently unsigned. Windows SmartScreen may show an
unknown-publisher warning; publishing without that warning requires a trusted
Windows code-signing certificate.
