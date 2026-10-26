# Working on Agent Dispatch Hub

Read README-AI.md for installation work and docs/README-DEVELOPMENT.md for code changes.
Use a named target and its workspace mapping. Local and remote paths refer to different
machines. Do not guess a remote working directory or copy a local path to a remote target.
Keep credentials in the user state directory, outside this repository. Never print tokens,
Cookies, authenticated URLs, or full credential objects in logs, errors, test evidence, or commits.
Tests use disposable fixtures and mock services; real dispatch requires the user's intended target.
Do not overwrite existing Codex or DSH settings: inspect, merge, and preserve a backup.
Document what was tested locally, what was tested with mock services, and what still needs a real endpoint.

## 提交与更新说明

每次更新都先讲清楚为什么改、最重要的用户需求和改后的能力，再说明必要的实现及验证。
提交标题、PR 标题和更新记录使用同一条需求主线，不只罗列文件名、函数或内部机制。
例如本次写明“支持 Codex 与 DSH 双向问答，执行者遇到问题可向负责人求助并继续原任务”。
功能范围与验证边界如实说明，任务内问答不表述为后台主动唤醒。
