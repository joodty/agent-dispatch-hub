# Working on Agent Dispatch Hub

Read README-AI.md for installation work and docs/README-DEVELOPMENT.md for code changes.
Use a named target and its workspace mapping. Local and remote paths refer to different
machines. Do not guess a remote working directory or copy a local path to a remote target.
Keep credentials in the user state directory, outside this repository. Never print tokens,
Cookies, authenticated URLs, or full credential objects in logs, errors, test evidence, or commits.
Tests use disposable fixtures and mock services; real dispatch requires the user's intended target.
Do not overwrite existing Codex or DSH settings: inspect, merge, and preserve a backup.
Document what was tested locally, what was tested with mock services, and what still needs a real endpoint.
