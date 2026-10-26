# Placement and routing contract, v0.2

Independent team messages in v0.4 use a separate `TeamService`, store and scheduler;
they do not require or create a dispatch job. Owner MCP tools are
`hub_team_members`, `hub_message_send`, `hub_message_receipt`,
`hub_message_run_once`, `hub_message_recover`. Member HTTP is authenticated
`POST /team/v1/messages`, limited to `send` and `read` for that credential's
member. Native DSH tools derive session identity from the calling agent. Project
configuration, enabling and budget changes are owner CLI operations only.
`delivered` means original-session queue admission, never downstream completion.
States and recovery ordering: [messaging design](MESSAGING-DESIGN.md).

CLI and MCP share `Hub`, the job store and adapter registry. Connections and
credentials retain their v1 transport shape. New dispatch requires an explicit
instance binding and a v2 mapping; [v1](interface-contract-v1.md) remains readable
for diagnosis and deliberate migration, with no implicit dispatch fallback.

Schema and native DSH behavior: [PLACEMENT-V2.md](PLACEMENT-V2.md).
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

The controller also exposes `hub_questions({jobId})` (local, read-only) and
`hub_answer({jobId,questionId,text})` (submits one answer, then use `hub_wait`).
New dispatches freeze `questionProtocol:{version:1,maxQuestions}` and a bounded
`questions` ledger; maxQuestions defaults to 5, accepts 0–10, and 0 disables it.
Old receipts are not enrolled. A strict current-request final reply becomes
`status:"needs_input",completed:false,turnCompleted:true,needsInput:true,question`.
Its original completed turn remains in `backendResult`. Question states are `open`, `answer-pending`,
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
