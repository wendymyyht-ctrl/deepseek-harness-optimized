# Implemented features

This document distinguishes project-specific optimizations, retained upstream
Harness capabilities, and capabilities the project does not claim.

## Project optimizations

- Programmatic HTML parsing, indexing, search, extraction, comparison, and cache.
- Automatic choice between indexed evidence, focused source, and guarded full or paged source reads.
- Automatic compact-and-continue after a provider reports a `max-tokens` stop.
- Restored context compaction plus pruning of oversized tool results.
- Opt-in GitHub and Notion MCP connectors with per-user OAuth.
- Google Workspace command tools with per-user OAuth.
- QQ Mail and NetEase Mail IMAP/SMTP tools with OS-protected authorization codes.

## Retained Harness capabilities

- Self-contained macOS and Windows desktop builds, plus the Node.js source distribution.
- Custom OpenAI-compatible endpoints for locally served DeepSeek, Qwen, and other models.
- Multiple saved providers and model switching without restarting Harness.
- Provider-defined context limits rather than a hard-coded 64K, 262K, or 1M limit.
- Local JSONL conversation persistence and recovery after app or machine restarts.
- Harness file, terminal, plan, goal, subagent, workflow, and model-settings surfaces, subject to runtime permissions.
- Per-user runtime data isolation; public artifacts include no credentials, histories, personal memory, or model weights.
- One shared 1.2.0 version across the macOS and Windows desktop artifacts.

## Cross-conversation memory boundary

The current release persists and resumes each conversation. It does not silently
inject every other conversation into a new chat and does not ship a personal
global-memory database. That distinction limits privacy exposure and context
bloat. A future explicit memory layer should be opt-in, inspectable, editable,
deletable, and retrieval-based.
