# DeepSeek Harness Optimized

[中文说明](README.zh-CN.md)

A privacy-safe, reusable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web profile. It keeps large HTML outside the model context until the model needs specific evidence, and automatically compacts and continues when a response reaches its output limit.

This is an independent community project, not an official DeepSeek release. It contains no API key, conversation, memory database, browser profile, personal automation, local model, or model weight. Every user supplies their own model endpoint and credentials.

## Desktop apps

### Windows EXE

Windows 10/11 x64 users can download a single-file Portable EXE from [GitHub Releases](https://github.com/wendymyyht-ctrl/deepseek-harness-optimized/releases). It bundles Electron, Node.js, Harness, and the optimized profile, and opens in a standalone desktop window. Runtime data is stored under `%APPDATA%\DeepSeek Harness Optimized`.

The community EXE is currently unsigned, so Windows SmartScreen may show an unknown-publisher warning. Verify the download against the SHA256 file attached to the Release.

### macOS app

Apple Silicon users on macOS 13 or newer can download the ZIP or DMG from [GitHub Releases](https://github.com/wendymyyht-ctrl/deepseek-harness-optimized/releases). The app bundles its own verified Node.js runtime and opens Harness in a native window; no separate Node.js installation is required.

The community build is ad-hoc signed and not notarized. On first launch, Control-click the app and choose **Open** if macOS blocks a normal double-click. Credentials and conversations are written only to `~/Library/Application Support/DeepSeek Harness Optimized`.

## What it changes

### Indexed HTML fast path

For local `.html` and `.htm` files, the profile tells the agent to inspect the file through programmatic tools first:

1. parse the complete file with Node.js;
2. build a compact index of headings, visible blocks, attributes, code and embedded JSON;
3. search, extract or compare only the relevant blocks;
4. send bounded evidence to the model for reasoning.

The model can still read exact markup. Source-level DOM/CSS/JavaScript debugging selects focused source automatically, while an explicit request for the complete/raw HTML enables a guarded full or paged source read. HTML is treated as untrusted data, not instructions.

This usually cuts prompt construction and inference time substantially on large pages because scripts, styles, repeated markup and unrelated records are not copied into every model request. The exact speed-up depends on the file and model endpoint.

### Automatic compact and continue

When the provider ends a response with `max-tokens`, the profile asks Harness to compact eligible context and queues a continuation automatically. It does not trigger for ordinary stops, and it does not continue when no safe compaction is available.

### Live model switching

Harness supports DeepSeek, catalog providers, and custom OpenAI-compatible endpoints. A saved model change takes effect on the next request without restarting the server. Existing conversations keep the route recorded in their own session; choose the desired model for a new conversation when you want a clean switch.

### Local models and persistent conversations

Ollama, vLLM, llama.cpp, and other local OpenAI-compatible servers can be added as custom providers, including locally served DeepSeek and Qwen models. No model weights are bundled, and the project does not hard-code a 64K, 262K, or 1M context limit; the selected model and inference server determine the actual limit.

Harness stores conversations locally so an existing session can be reopened after the app or computer restarts. This is durable session history, not silent global memory: the public build does not inject every old conversation into every new chat and ships no personal memory database. See [Implemented features](FEATURES.md) for the exact boundary.

## Requirements

- Node.js `22.19` or newer in the 22.x line, or Node.js 24+
- npm, pnpm, or another package manager that supports npm workspaces
- A model API key or an accessible OpenAI-compatible local endpoint

## Quick start

```bash
git clone https://github.com/wendymyyht-ctrl/deepseek-harness-optimized.git
cd deepseek-harness-optimized
npm install
npm start
```

Open the URL printed by Harness, normally `http://127.0.0.1:3080`. Then open **Settings → Models**:

- enter your own DeepSeek key, or
- add a catalog provider, or
- add a custom provider with a lower-case provider ID, base URL, API protocol, credential and model ID.

Credentials are stored under the runtime home (by default `~/.dsh-optimized/.credentials.yaml`), outside this Git checkout. They are write-only in the Web UI and are never bundled in this repository.

Pass normal Web arguments after `--`:

```bash
npm start -- --help
```

## Runtime isolation

The launcher creates a dedicated runtime home at `~/.dsh-optimized` and links this repository's profile into it. Override the location or profile name if needed:

```bash
DSH_HOME=/path/to/runtime DSH_PROFILE=my-profile npm start
```

The setup script refuses to overwrite an existing profile directory or a link to another profile.

For advanced configuration, copy the structure in `settings.example.yaml` into `$DSH_HOME/settings.yaml` and provide the referenced key through an environment variable. Prefer **Settings → Models** for normal use.

## Verify before sharing changes

```bash
npm run verify
```

The test suite covers routing, indexing, bounded source access, comparison, index caching, and automatic continuation. The security check rejects common credential formats, private runtime filenames, model weights and personal macOS paths.

## Intentionally excluded

Personal memory, past conversations, account integrations, browser state, automations, API credentials, local model routers, launch services, GGUF/SafeTensors files and machine-specific paths are intentionally excluded. A local DeepSeek or Qwen server can still be added from **Settings → Models** as a custom OpenAI-compatible provider.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). DeepSeek Harness remains an upstream dependency distributed under its own MIT license.
