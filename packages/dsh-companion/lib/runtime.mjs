// Public DSH host services only. Never write workspace records or SessionHeader.
export function runtimeFor(ctx) {
  for (const [name, method] of [
    ["workspaceRegistry", "list"],
    ["workspaceRegistry", "create"],
    ["sessionController", "create"],
    ["agents", "get"],
    ["workingDirectory", "set"],
    ["workingDirectory", "ensure"],
    ["workingDirectory", "get"],
    ["sessionQuery", "observeSession"],
  ])
    if (typeof ctx[name]?.[method] !== "function")
      throw new Error("Unsupported DSH host placement service contract.");
  const view = (w) => ({
    id: w.id,
    path: w.path,
    title: w.title,
    sessionIds: [...w.sessionIds],
  });
  return {
    listWorkspaces: async () => ctx.workspaceRegistry.list().map(view),
    createWorkspace: async (path, title) =>
      view(await ctx.workspaceRegistry.create(path, title)),
    createSession: (args) => ctx.sessionController.create(args),
    setCwd: async (sessionId, cwd) => {
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new Error("Newly created DSH agent is unavailable.");
      return ctx.workingDirectory.set(agent, cwd, new AbortController().signal);
    },
    observeSession: async (sessionId) => {
      const observation = await ctx.sessionQuery.observeSession(sessionId);
      try {
        const actualCwd = observation.projections?.values?.workingDirectory;
        if (
          typeof actualCwd !== "string" ||
          typeof observation.header?.cwd !== "string"
        )
          throw new Error(
            "DSH effective working-directory projection is unavailable.",
          );
        return { initialCwd: observation.header.cwd, actualCwd };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
  };
}

// Only sessions newly admitted by this companion are guarded. Existing sessions
// retain their original behavior. The wrapper prevents DSH's missing-cwd fallback.
export function guardManagedDirectories(workingDirectory, service) {
  const ensure = workingDirectory.ensure,
    set = workingDirectory.set;
  const recordFor = (agent) =>
    [...service.records.values()].find(
      (r) => r.sessionId === agent.id && (r.context || r.expectedCwd),
    );
  async function guardedEnsure(agent, signal) {
    const record = recordFor(agent);
    if (!record) return ensure.call(this, agent, signal);
    signal?.throwIfAborted();
    await service.verify({ jobId: record.jobId, sessionId: agent.id });
    return record.context.execution.actualCwd;
  }
  async function guardedSet(agent, path, signal) {
    const record = recordFor(agent);
    if (!record) return set.call(this, agent, path, signal);
    signal?.throwIfAborted();
    // Resolve using DSH's public target-local directory service; no mutation yet.
    const resolved = await this.directory(
      path,
      this.get(agent.session),
      signal ?? new AbortController().signal,
    );
    const expected = record.context?.execution.actualCwd ?? record.expectedCwd;
    const same =
      service.instance.pathStyle === "win32"
        ? resolved.toLowerCase() === expected.toLowerCase()
        : resolved === expected;
    if (!same) {
      const error = new Error(
        "Managed task cwd is fixed by its dispatch receipt.",
      );
      error.code = "cwd-change-forbidden";
      throw error;
    }
    if (record.initializing) return set.call(this, agent, resolved, signal);
    await service.verify({ jobId: record.jobId, sessionId: agent.id });
    return expected;
  }
  workingDirectory.ensure = guardedEnsure;
  workingDirectory.set = guardedSet;
  return () => {
    if (workingDirectory.ensure === guardedEnsure)
      workingDirectory.ensure = ensure;
    if (workingDirectory.set === guardedSet) workingDirectory.set = set;
  };
}
