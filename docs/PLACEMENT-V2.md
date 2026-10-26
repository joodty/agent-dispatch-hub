# Placement v2 implementation contract

Implemented in v0.2. Validation scope and limitations are recorded separately;
this contract describes required behavior, not proof of every deployment.

## Observed DSH rc.3 behavior

`session.create` accepts `workspaceId` or `cwd`, never both. Workspace membership
uses the original SessionHeader.cwd, which must resolve exactly to the workspace
directory. `workspace.insertSessionBefore` only reorders existing members.
The public host `workingDirectory.set(agent,path,signal)` commits the effective
directory projection without changing the header or file permissions. A companion
can therefore create a new session in a workspace, set its effective task cwd,
verify both, and only then admit a model prompt. It must not patch membership
records, falsify headers or move existing sessions.

## Configuration

The top-level config version is 2. Connection credentials keep their v1 layout.
Every DSH target has an instance binding returned by its authenticated companion.
`workspaces` remains the CLI mapping-alias table for backward argument compatibility;
each mapping now separates four concepts:

```json
{
  "adapter": "dsh",
  "instance": { "id": "<server-issued-instance-uuid>", "pathStyle": "posix" },
  "connection": { "kind": "remote", "baseUrl": "https://dsh.example.com", "credentialFile": "/absolute/hub-state/credentials/remote.json" },
  "workspaces": {
    "project": {
      "dshWorkspace": { "id": "<workspace-id-on-this-instance>", "onMissing": "error" },
      "execution": { "mode": "subdirectory", "root": "/absolute/tasks", "template": "{date}-{jobId}", "create": true },
      "source": { "root": "/absolute/source/project" },
      "scope": { "read": ["/absolute/source/project", "{taskCwd}"], "write": ["{taskCwd}"], "enforcement": "instructions" }
    }
  }
}
```

Alternatively `dshWorkspace` may use `path` (no id) and `onMissing: create`.
Workspace registration requires that directory already exist. No directory is
implicitly created by registering a workspace. `execution.mode: fixed` uses `cwd`
instead of root/template. A missing fixed directory can be created only if create
is true and its parent exists. A generated subdirectory requires an existing root;
its template is one filename segment, with `{jobId}`, `{date}`, `{target}` and
`{mapping}` substitutions. Reject traversal, drive-relative or wrong-OS paths.
No fallback path, workspace or instance is allowed.

`scope.enforcement: instructions` is explicit: the ranges are a task contract,
recorded in receipts and injected into the task. DSH's actual sandbox is separate;
grouping does not tighten permissions. `sandbox-required` must fail as unsupported
until a real range-enforcing backend exists. Never widen DSH's global permissions.

## Pure shared validator

File: `packages/dsh-companion/lib/placement.mjs`, no third-party dependencies.
Export `PlacementError` with code/message/field; `validateTargetBinding(instance)`;
`validateMapping(mapping,pathStyle)`; `planPlacement({instance,mapping,targetName,
mappingName,jobId,now})`; `normalizeTargetPath(path,pathStyle)`; `isWithin(path,root,
pathStyle)`. Use path.win32/posix explicitly, never local resolve on target paths.
Return a plain plan with instance, dshWorkspace selector, execution (including
requestedCwd), source and fully substituted scope ranges. Reject unsupported
placeholders/fields that imply stronger enforcement. Client and server share it.

## Authenticated host companion

Package: `packages/dsh-companion` (`agent-dispatch-hub-dsh`, v0.2.0). HTTP endpoint
`/plugins/agent-dispatch-hub/v2/control`, POST JSON {operation,instanceId?,params?}.
Every request must pass `ctx.connection.admit` as owner; no public unauthenticated
filesystem operations. Transport authentication remains DSH's own Cookie/token.

- `inspect`: return protocolVersion:2, persistent per-profile instance.id,
  instance.pathStyle, capability flags, and workspace views (id,path,title).
- `prepare`: params {jobId,plan}. Require the exact instance id; validate paths
  and scopes on the target, realpath containment and existing source/root before
  side effects. Only explicit workspace/directory creation. Create only a NEW
  session (never attach/reuse/move a previous session); native workspaceId first,
  then workingDirectory.set before any prompt. Return sessionId plus context.
  Persist each admission so a failure returns a known session id. Retry of the
  same job id is idempotent only when the plan hash matches.
- `verify`: params {jobId,sessionId}. Return stored context and observed effective
  cwd, original header directory and actual workspace membership; error on drift.
- `readArtifact`: params {jobId,sessionId,path}. Only a clean relative regular text
  file under the recorded effective cwd and declared read ranges; reject symlink
  escapes, 128 KiB max. Return {text,eof:true,absolutePath}.

Use public services workspaceRegistry, sessionController, agents,
workingDirectory, sessionProjections/sessionQuery. The original header remains
the native workspace anchor. For only companion-managed NEW sessions, prevent
workingDirectory.ensure from silently restoring a missing cwd and prevent a
tool changing the fixed cwd. Leave all unmanaged sessions untouched. Guard public
method contracts and refuse unsupported runtimes; no private registry patches.
Store identity and managed receipts per profile, outside source repositories.
Publish a private profile-specific connection file compatible with v1 transport.

## Hub receipts and compatibility

Receipt v2 freezes instance id, connection fingerprint, mapping snapshot/hash,
resolved DSH workspace, original native directory, requested/actual cwd, source
root/canonical path and read/write ranges. New dispatch requires v2 mapping.
Default target switching cannot reroute jobs. Connection or instance changes
fail closed. Mapping policy edits block new follow-up prompts to old jobs;
read/wait/cancel continue against their frozen verified instance/context.

v1 configurations remain readable for diagnostics, inspect and migration. Never
guess a DSH workspace from a path alias. Provide a migration plan and explicit
apply. v1 receipts are never automatically rewritten or regrouped/stopped; an
explicit legacy-bind command may bind their original session id/cwd to a verified
instance for read/wait/cancel, recording actual membership (including ungrouped).
It must not move the session. New follow-ups require a new fully configured v2 job.

## Acceptance boundaries

Only the explicitly selected company local DSH is authorized for live tests.
Remote services are mocked. Verify workspace membership, projected effective cwd,
and the artifact absolute path and content through authenticated APIs. Preserve
all existing active sessions. Installing/loading the companion must not require
desktop control without the user's separate sidebar confirmation.
