# v1.4.0 release plan

Goal: publish the tested DSH 0.1.7-rc.1 upgrade with reusable local capabilities and macOS arm64 / Windows x64 desktop artifacts.

- [x] Upgrade pinned dependencies, adapt preset scopes and vision settings, and keep user model/account settings outside release artifacts.
- [x] Port local memory, document, media, search and automation modules to per-user paths; preserve existing portable account integrations.
- [x] Adapt both desktop launchers to token-bearing startup URLs and the profile-based CLI invocation.
- [ ] Build, audit and smoke-test both payloads; compile macOS app and Windows executable. State any Windows native validation limits.
- [ ] Update bilingual instructions, commit and push source; publish versioned release artifacts with SHA-256 checksums.

Review focus: clean install with no credentials; upgrade without overwriting profile edits; spaces in user paths; native dependency architecture; no personal runtime data in source or artifacts.
