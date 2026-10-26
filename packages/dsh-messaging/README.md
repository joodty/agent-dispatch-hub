# Agent Dispatch Hub Messaging

Adds `hub_ask_advisor` and `hub_advisor_message` to ordinary DSH sessions. A prior
Hub dispatch job is not required. The calling session identity comes from DSH's
tool execution context; member identity comes from a protected connection file.

Configure the selected DSH profile through `team install-dsh`, or set an explicit
`connectionFile` in the plugin configuration. By default the plugin reads the
profile-local `.agent-dispatch-hub-messaging/connections.json` catalog. Multiple
projects require the tool's explicit `project` argument. Credentials stay outside
source control and are never returned to the model.

Use the DSH native plugin manager. Do not overwrite a running installation or
bypass restart requirements. This plugin does not change the selected model,
sandbox or permissions. Replies are AI advice and do not grant human approval.

The Hub service must be reachable; a stored receipt means queued, not model
completion. End the originating turn after asking rather than polling. Full
setup and limitations are documented in the repository's messaging guide.
