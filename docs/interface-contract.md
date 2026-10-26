# Placement and routing contract, v0.3

CLI and MCP share `Hub`, the job store and adapter registry. Connections and
credentials retain their v1 transport shape. New dispatch requires an explicit
instance binding and a v2 mapping; [v1](interface-contract-v1.md) remains readable
for diagnosis and deliberate migration, with no implicit dispatch fallback.

Schema and native DSH behavior: [PLACEMENT-V2.md](PLACEMENT-V2.md).
Optional managed safety-run protocol: [SAFETY-V0.3.md](SAFETY-V0.3.md).
Migration and installation: [README-PLACEMENT.md](README-PLACEMENT.md).
Portable examples: [config.example.json](../examples/config.example.json).

Adapters implement `inspect`, `assertInstance`, `prepare`, `verify`, `send`, `wait`, `confirmPrompt`,
`cursor`, `messages`, `cancel`, `readArtifact`, `observeLegacy`, `status`, `close`. `prepare`
returns `{sessionId,context}`. `verify` returns the same context after observing
the backend. Context contains `instance`, `dshWorkspace`,
`execution:{requestedCwd,actualCwd,initialCwd}`, `source:{root,canonicalRoot}`
and `scope:{read,write,enforcement}`.

Dispatch persists a pending receipt, validates the authenticated instance,
prepares a **new** session, persists its identity, verifies placement, sends the
scope instructions and task, persists the request cursor, waits, then verifies
placement again. Partial admission retains its known session ID. Timeout does
not mean cancellation. No default instance or directory is guessed.

Receipt v2 freezes connection fingerprint, instance, original mapping and hash,
plan and observed context. Existing jobs use their recorded target. Connection
or identity changes fail closed; mapping edits block new follow-up prompts.
Read/wait/cancel retain original placement. Waits do not hold the short writer
lock; stale waits cannot overwrite newer follow-ups.

DSH companion operations are owner-authenticated POSTs at
`/plugins/agent-dispatch-hub/v2/control`: `inspect`, `prepare`, `verify`,
`readArtifact`, `observeLegacy`. Identity-specific operations require the exact
instance ID. Paths are validated on the target. Creation requires explicit
configuration; effective cwd is set before any prompt. The companion guards only
its newly admitted sessions against cwd changes and DSH's missing-directory
fallback. It never edits native headers or membership records. `observeLegacy`
is read-only and does not resume a session.

MCP: `hub_targets`, `hub_status`, `hub_inspect`, `hub_dispatch`, `hub_send`,
`hub_wait`, `hub_messages`, `hub_cancel`, `hub_verify`, `hub_artifact`.
v0.3 adds `hub_dispatch_readonly` and `hub_changes`, and CLI `dispatch-readonly`
and `changes --job ID [--request-id UUID]`. All use the original DSH transport.
`wait` and `changes` may reconcile target-side bookkeeping and release verified
completed leases; their MCP annotations are not read-only.

The controller also exposes `hub_questions({jobId})` (local, read-only) and
`hub_answer({jobId,questionId,text})` (submits one answer, then use `hub_wait`).
New dispatches freeze `questionProtocol:{version:1,maxQuestions}` and a bounded
`questions` ledger; maxQuestions defaults to 5, accepts 0–10, and 0 disables it.
Old receipts are not enrolled. A strict current-request final reply becomes
`status:"needs_input",completed:false,turnCompleted:true,needsInput:true,question`.
Its original completed turn remains in `backendResult`; safety reconciliation
still uses native completion. Question states are `open`, `answer-pending`,
`answered`, `cancelled`, `limit-reached`. Question IDs derive from job/request.
Answers and their identity/hash are persisted before submission. Repeating the
same answer returns its original admission or confirms it without resending;
different answers conflict. Pending questions block ordinary sends; cancelled
jobs cannot be resumed. Limits return `question_limit_reached`, malformed
envelopes `question_error`. No target API, model selection, or desktop wakeup is
added. Protocol, sizes and lock semantics: [task questions](README-QUESTIONS.md).
Recovery tools: `hub_recover`, `hub_retry`, `hub_receipt`. Prompt IDs/cursors are
persisted before admission, and the adapter must preserve both. An uncertain
prompt blocks new sends; `retry` requires identical text and confirms the original
ID from recorded messages or inbox without resending. Absence is uncertain, not
permission to repeat a prompt. Placement recovery reuses the frozen job/plan and sends no prompt. Completion
evidence is stored as `backendResult` before post-wait placement checks; a failed
check still errors, with evidence available through the local receipt.
CLI adds `target inspect`, `target configure --mapping-file`, `legacy-bind`,
`verify`, `artifact`. Existing setup commands stage a connection and legacy alias;
new dispatch remains blocked until explicit placement configuration is applied.

Target paths use instance `pathStyle`. Connection/credential files are controller
local; workspace/task/source/scope paths belong to the target. Remote connections
require explicit HTTPS and separately paired credentials. No probing of ports,
browsers, other profiles or hosts. Grouping and task instructions grant no file
permissions. DSH rc.3 lacks arbitrary per-session read/write root enforcement;
`sandbox-required` is rejected.

Companions may advertise `capabilities.safeRunsVersion:1`. Only new jobs opt in
via `prepare({jobId,plan,safetyVersion:1,capability:'coding'|'readonly'})` and
freeze that capability in `context.safety:{version:1,capability}`. The plan hash
includes capability/version. Receipts retain these fields, `runAudit`, and any
`runError`; older receipts keep their original behavior. Unsupported targets
return `safety.supported:false` for coding and reject readonly before creating
a session. Recovery resubmits the original frozen capability, never a default.

Adapters and the authenticated target endpoint add `beginRun`, `finishRun`,
`changes`, each taking `{jobId,sessionId,requestId}`. The target acquires the
lease and baseline before the controller sends. Returns include run ownership,
state, capability, roots, change-capture coverage and, when finished, changes.
Only the target's observed DSH events/activity/inbox determine completion;
clients cannot submit a `completed` boolean to release a lease. Neither prompt
retry nor changes resends a model request. Historical request queries must
match the original instance/job/session. Snapshots store metadata, not content.
