# Agent Dispatch Hub DSH companion

Authenticated placement admission, not a model provider. DSH rc.3 public host
services create a new grouped session, then set and verify its effective cwd
before the controller sends a model prompt.

The Hub local installer includes this package. A remote administrator can run
`npm pack --ignore-scripts` here, install the tarball with DSH's native plugin
manager into the selected profile, and configure its profile patch explicitly:

```yaml
- id: agent-dispatch-hub-placement
  config:
    stateDirectory: /absolute/private/profile-state/agent-dispatch-hub
```

Protect this directory for the DSH service user (0700 on POSIX; equivalent user
ACL on Windows). It holds per-profile identity and managed task receipts. Never
commit/copy them to another instance. Loopback hosts also publish a private
`connection.json` here. Inspect never returns tokens. Remote credentials use
separate explicit pairing; local setup never installs remotely.

`/plugins/agent-dispatch-hub/v2/control` requires DSH owner admission. Incompatible
runtime contracts fail on load, with no ungrouped fallback. Keep the plugin
loaded and its state intact while tasks run. It guards only its newly created
sessions and never moves, resumes or stops existing ones. Ranges are explicit
instructions, not an arbitrary-roots sandbox. See
[placement and migration](../../docs/README-PLACEMENT.md).
