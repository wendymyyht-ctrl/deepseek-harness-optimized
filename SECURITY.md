# Security policy

This repository contains only reusable profile/source code and pinned public third-party download metadata. It must not contain API keys, OAuth tokens, email authorization codes, connected-account records, conversations, memory databases, browser profiles, automation data, model weights, or machine-specific paths.

Keep real credentials in the Harness runtime home, environment variables, macOS Keychain, or the current Windows user's DPAPI-protected credential file. The included `.gitignore` excludes common secret and runtime files, and `npm run security-check` scans the working tree before publication. Google, GitHub and Notion authorization is always completed by the downloader after installation; no maintainer account is bundled.

Vision Toolkit's built-in provider is an external shared service. Model-backed vision operations send the selected image and task-focused prompt to the configured provider. Users who require an entirely local or private data path must configure their own compatible endpoint before using those operations. Provider credentials are stored by Harness at runtime and are never bundled in this repository; deterministic image-processing operations run locally.

If a credential is ever committed, revoke or rotate it immediately. Removing it from the latest commit is not sufficient because it may remain in Git history. Please do not paste secrets into a public issue; report security concerns privately to the repository owner through GitHub.
