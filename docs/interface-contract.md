# Internal interface contract for v0.1.0

The CLI is `node bin/adh.mjs`. State defaults to `~/.agent-dispatch-hub`, overridden by
`ADH_HOME` or `--home <absolute-directory>`. Repository code is portable and contains no
machine-specific endpoint, credential, model account, workspace, or source checkout path.

Config at `<home>/config.json`:

```json
{
  "version": 1,
  "defaultTarget": "office",
  "targets": {
    "office": {
      "adapter": "dsh",
      "connection": { "kind": "local", "connectionFile": "/absolute/dsh-home/.codex-dsh-bridge/connection.json" },
      "workspaces": { "demo": "/absolute/local/project" }
    },
    "home": {
      "adapter": "dsh",
      "connection": { "kind": "remote", "baseUrl": "https://dsh.example.com", "credentialFile": "/absolute/user-state/credentials/home.json" },
      "workspaces": { "demo": "/absolute/path/on/remote/machine" }
    }
  }
}
```

The hub never dispatches without a known target and an explicitly mapped workspace.
The chosen target and workspace are captured in a job receipt. Later send, wait,
messages and cancel use the receipt's target, even after `target use` changes the default.
Changing that target's connection invalidates its old receipt until the original connection
is restored; it never silently sends a session ID to a different DSH.

External sources are pinned in `dependencies.lock.json` (Git URL + full SHA). Bootstrap
clones into `<home>/dependencies`, verifies commits, and installs pinned dependencies
with lifecycle scripts disabled. The DSH adapter imports the pinned bridge's
`scripts/dsh-client.mjs`. Bridge options are passed as env objects, without mutating
process.env: local connection-file mode, or explicit remote HTTPS + cookie/token mode.

CLI contracts planned for v0.1.0:

- `doctor`: report prerequisites, dependency pins, target/config readiness; redact credentials.
- `bootstrap`: fetch and verify pinned external projects.
- `setup local --target office --dsh-home ... --profile desktop --workspace demo=/path --codex-home ...`: install companions, merge settings, register hub MCP, add target; all paths inferred only when unambiguous.
- `setup remote --target home --url https://dsh.example.com --workspace demo=/remote/path --codex-home ...`: add remote target and register MCP; remote DSH installation is managed separately, never guessed or changed.
- `target list`, `target use office`, `target pair home`: pair reads a launch URL from stdin (or a protected file), exchanges it at that exact origin and stores the signed browser Cookie privately; never print the input or Cookie.
- `status --target office`
- `dispatch --target office --workspace demo --text "..." [--timeout-ms 55000]`
- `send --job <id> --text "..."`, `wait --job <id>`, `messages --job <id>`, `cancel --job <id>`
- `mcp`: one generic tool surface: `hub_targets`, `hub_status`, `hub_dispatch`, `hub_send`, `hub_wait`, `hub_messages`, `hub_cancel`.
- `smoke --target office --workspace demo`: real model acceptance creates only a new subdirectory of that target workspace; opt-in command, never part of bootstrap or doctor.

Adapters implement status, dispatch, send, wait, messages, cancel and close. New
backends register with AdapterRegistry; generic routing, job storage, MCP, CLI and
documentation do not depend on DSH internals. v0.1.0 ships only the DSH adapter.

Remote HTTP is rejected; HTTPS uses normal certificate validation. Remote bearer
credentials are bound to the exact configured origin. A local target only accepts a
loopback endpoint from the explicitly configured companion file. No auto-probing
of browser sessions, local ports, other profiles, or other machines.
