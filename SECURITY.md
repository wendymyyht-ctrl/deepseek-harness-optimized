# Security policy

This repository contains only reusable profile/source code and pinned public third-party download metadata. It must not contain API keys, OAuth tokens, email authorization codes, connected-account records, conversations, memory databases, browser profiles, automation data, model weights, or machine-specific paths.

Keep real credentials in the Harness runtime home, environment variables, macOS Keychain, or the current Windows user's DPAPI-protected credential file. The included `.gitignore` excludes common secret and runtime files, and `npm run security-check` scans the working tree before publication. Google, GitHub and Notion authorization is always completed by the downloader after installation; no maintainer account is bundled.

If a credential is ever committed, revoke or rotate it immediately. Removing it from the latest commit is not sufficient because it may remain in Git history. Please do not paste secrets into a public issue; report security concerns privately to the repository owner through GitHub.
