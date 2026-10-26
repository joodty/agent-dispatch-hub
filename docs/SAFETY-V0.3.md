# DSH safety extensions, v0.3

Implemented contract; validation results are recorded separately. Keep the
existing DSH transport, model selection, v2 placement and legacy jobs intact.
This is an implementation of useful concepts, not an import of another runtime.

## New managed tasks

New companions advertise `safeRunsVersion:1`. New jobs on these companions freeze
`safetyVersion:1` and `capability: coding | readonly` in their receipts and native
placement record. Older companions keep the v0.2 coding path with an explicit
unsupported safety status; readonly dispatch must fail without the capability.
Older jobs never silently acquire new restrictions or leases.

Readonly dispatch is a distinct API. Before its first prompt, use DSH's public
per-agent tool restrictions and monotonic execution guard. Only verified native
`read`, `glob`, `grep` definitions may run, with no shell, write/edit, arbitrary MCP actions,
subagents or permission-changing tool. Follow-up text cannot change this frozen
capability. Do not change the global model, sandbox or standard preset. If the
runtime cannot enforce this contract, fail before prompting.

## Run admission and workspace leases

Before each new prompt the controller persists its request identity, then calls
`beginRun({jobId,sessionId,requestId})`. It never sends a prompt if preparation,
lease acquisition or the baseline snapshot failed or was not confirmed.

The target companion acquires a durable lease on canonical source and declared
write roots. Write/coding leases are exclusive for overlapping ancestor/child
roots; readonly leases may share, but conflict with a coding lease. Target OS
path semantics apply. This coordinates managed jobs on the same DSH instance,
across aliases and controller processes, not IDE edits or unmanaged sessions.

Different requests on one managed job cannot queue past an active run. Finish
and inspect the original run first. Timeouts, controller exit and cancel requests
do not release leases. Release only after target-observed terminal evidence for
that request, no live activity/inbox, and successful change capture. Unknown
states remain held. Never infer completion from a client boolean or a dead Hub.
Native descendant identities are persisted before their creation listener
returns. Their live activity or cold log/inbox participates in completion;
their tool calls inherit the original job's gate, including after restart.

Target operations: `beginRun`, `finishRun`, `changes`. Their identity is bound to
the original instance/job/session/request. `finishRun` and `changes` may write
bookkeeping. An already-finished run returns its recorded immutable summary.

## File change records

Capture bounded before/after metadata snapshots of declared write roots for
coding runs. Record additions/modifications/deletions with relative path, file
type, size and SHA-256; never store file contents. Do not follow symlinks, read
outside roots, copy secrets into logs, restore files or claim a mutation journal.
Changes observed across the interval are not proof of which actor made them.
Shell background processes and external edits are outside attribution guarantees.

Default bounds: 2500 files, 2 MiB per file, 32 MiB total content, 20 seconds.
Exclude `.git`, `.svn`, `.hg`, `node_modules`, caches/build output and common
credential files and symlinks. Report exclusions without reading link targets.
Readonly runs report `changeCapture:not-captured-readonly`; they do not snapshot.
An exceeded bound or unstable scan is an
explicit error, not a partial "complete" audit. Missing roots are allowed only
for the after-snapshot, recording deletions. Snapshot failure retains the lease.
No manual acknowledgment is required for ordinary records in this version.
An administrator may explicitly set the companion's `snapshotLimits` fields;
unknown/invalid options fail. Each baseline freezes effective bounds for its
after-snapshot. Changing profile config does not weaken an existing run's audit.

## Independent modules

`packages/dsh-companion/lib/source-leases.mjs` exports `LeaseError` and
`SourceLeaseStore({directory,instanceId,pathStyle})` with async
`acquire({runId,jobId,sessionId,requestId,roots,mode})`, `release({runId,jobId,
sessionId,requestId})`, `list()`. Run IDs use `run-<uuid>`, jobs `job-<uuid>`.
Inputs are canonical absolute target paths; modes are `read`/`write`. Acquisition
is idempotent only for identical owner/roots/mode. Release requires the complete
original owner. A short OS-atomic mutex protects the durable lease table; never
expire an active or unknown lease by age or controller PID.

`packages/dsh-companion/lib/file-snapshots.mjs` exports `SnapshotError`,
`captureSnapshot({roots:[{id,path}],limits?,allowMissingRoots:false,signal?})`
and `diffSnapshots(before,after)`. A snapshot is
`{version:1,roots:[{id,path,state}],files:[{root,path,kind,size,sha256,mode}],
excluded:{count,rules},limits}`; paths in `files` are root-relative forward slash
paths. Results are deterministic. Diff returns an array of
`{root,path,change:'added'|'modified'|'deleted',before:null|metadata,
after:null|metadata}`. Scan natively on the target; source leases use explicit
path styles so pure boundary handling can be tested across platforms.

Unit tests cover enforcement, overlapping roots, aliases, cross-process races,
crash persistence, unknown outcomes, wrong-owner release, stable snapshots,
symlink escapes, limits and additions/modifications/deletions. Live validation
uses only the selected company-local DSH and disposable tasks. Installing an
updated companion must not interrupt existing tasks or control the desktop
without separate consent.
