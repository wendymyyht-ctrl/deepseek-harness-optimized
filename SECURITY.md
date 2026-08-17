# Security policy

This repository contains only a reusable profile and source code. It must not contain API keys, credentials, conversations, memory databases, browser profiles, automation data, model weights, or machine-specific paths.

Keep real credentials in the Harness runtime home or environment variables. The included `.gitignore` excludes common secret and runtime files, and `npm run security-check` scans the working tree before publication.

If a credential is ever committed, revoke or rotate it immediately. Removing it from the latest commit is not sufficient because it may remain in Git history. Please do not paste secrets into a public issue; report security concerns privately to the repository owner through GitHub.
