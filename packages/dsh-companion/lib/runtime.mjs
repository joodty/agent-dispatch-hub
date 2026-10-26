// Public DSH host services only. Never write workspace records or SessionHeader.
export function runtimeFor(ctx) {
  const readonlyAgents = new WeakMap(),
    readonlyDisposers = [];
  const safetySupported =
    typeof ctx.tools?.guard === "function" &&
    typeof ctx.tools?.get === "function" &&
    typeof ctx.tools?.wireSchemas === "function" &&
    typeof ctx.agents?.list === "function" &&
    typeof ctx.agents?.isOwnedBy === "function" &&
    typeof ctx.sessionQuery?.observeSession === "function";
  for (const [name, method] of [
    ["workspaceRegistry", "list"],
    ["workspaceRegistry", "create"],
    ["sessionController", "create"],
    ["agents", "get"],
    ["workingDirectory", "set"],
    ["workingDirectory", "ensure"],
    ["workingDirectory", "get"],
    ["workingDirectory", "directory"],
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
  const family = (root) => {
    if (!root) return [];
    const found = [root],
      seen = new Set([root.id]),
      agents = ctx.agents.list();
    for (let i = 0; i < found.length; i++)
      for (const candidate of agents)
        if (
          !seen.has(candidate.id) &&
          ctx.agents.isOwnedBy(candidate.id, found[i])
        ) {
          seen.add(candidate.id);
          found.push(candidate);
        }
    return found;
  };
  return {
    safetySupported,
    ownsAgent: (agent, rootSessionId, descendants = []) => {
      if (agent?.id === rootSessionId) return true;
      return (
        !!agent &&
        [rootSessionId, ...descendants].some((id) =>
          family(ctx.agents.get(id)).some((a) => a === agent),
        )
      );
    },
    configureReadonly: async (sessionId) => {
      const agent = ctx.agents.get(sessionId),
        tools = agent?.ctx?.tools;
      if (
        !safetySupported ||
        !agent ||
        typeof tools?.restrict !== "function" ||
        typeof tools?.presentAs !== "function"
      )
        throw Object.assign(
          new Error("DSH readonly tool enforcement unavailable."),
          { code: "readonly-unsupported" },
        );
      if (readonlyAgents.has(agent)) return;
      for (const name of ["read", "glob", "grep"])
        if (!tools.get(name, agent))
          throw Object.assign(
            new Error("DSH native read/search tools unavailable."),
            { code: "readonly-tools-unavailable" },
          );
      // Masks affect inherited tools only. The host guard below also checks
      // tools registered directly on this scope, and cannot be overridden by
      // an ordinary pre-execute allow decision.
      const restricted = tools.restrict({ allow: ["read", "glob", "grep"] });
      let presentation;
      try {
        const names = tools.wireSchemas(agent).schemas.map((s) => s.name);
        if (!["read", "glob", "grep"].every((name) => names.includes(name)))
          presentation = tools.presentAs("native");
        if (
          !["read", "glob", "grep"].every((name) =>
            tools.wireSchemas(agent).schemas.some((s) => s.name === name),
          )
        )
          throw new Error("DSH readonly native tool presentation unavailable.");
      } catch {
        presentation?.();
        restricted();
        throw Object.assign(
          new Error("DSH readonly tool presentation unavailable."),
          { code: "readonly-unsupported" },
        );
      }
      readonlyDisposers.push(() => {
        presentation?.();
        restricted();
      });
      readonlyAgents.set(
        agent,
        new Map(
          ["read", "glob", "grep"].map((name) => [
            name,
            tools.get(name, agent),
          ]),
        ),
      );
    },
    readonlyAllowed: (exec) => {
      const expected = readonlyAgents.get(exec.agent)?.get(exec.name);
      return (
        expected !== undefined &&
        ctx.tools.get(exec.name, exec.agent) === expected
      );
    },
    disposeSafety: () => {
      for (const dispose of readonlyDisposers.splice(0)) dispose();
    },
    observeRun: async (sessionId, requestId, descendantSessionIds = []) => {
      const observation = await ctx.sessionQuery.observeSession(sessionId);
      try {
        const events = observation.events;
        if (!Array.isArray(events))
          throw new Error("DSH event observation unavailable.");
        const users = events.filter(
          (e) =>
            e.type === "user/message" &&
            e.data?.source?.kind === "user" &&
            e.data.source.rpcId === requestId,
        );
        const user = users.length === 1 ? users[0] : undefined;
        const end =
          user &&
          events.findLast((e) => e.type === "turn/end" && e.seq > user.seq);
        const agent = ctx.agents.get(sessionId);
        // Absence of a live agent is not proof that its queued work disappeared.
        const quiescentLive =
          !!agent &&
          family(agent).every(
            (a) =>
              a.status !== "running" &&
              Array.isArray(a.inbox?.nextTurn) &&
              Array.isArray(a.inbox?.nextStep) &&
              a.inbox.nextTurn.length === 0 &&
              a.inbox.nextStep.length === 0,
          );
        let quiescent = quiescentLive;
        for (const id of descendantSessionIds) {
          const child = ctx.agents.get(id);
          if (child) {
            if (
              family(child).some(
                (a) =>
                  a.status === "running" ||
                  !Array.isArray(a.inbox?.nextTurn) ||
                  !Array.isArray(a.inbox?.nextStep) ||
                  a.inbox.nextTurn.length ||
                  a.inbox.nextStep.length,
              )
            )
              quiescent = false;
          } else {
            // Runtime ownership is not durable across restart. Retain the child
            // identity and observe its persisted log without resuming it.
            const observed = await ctx.sessionQuery.observeSession(id);
            try {
              const end = observed.events?.findLast(
                (e) => e.type === "turn/end",
              );
              const inbox = observed.projections?.values?.inbox;
              if (
                !end ||
                observed.events.some(
                  (e) => e.type === "turn/start" && e.seq > end.seq,
                ) ||
                !Array.isArray(inbox?.["next-turn"]) ||
                !Array.isArray(inbox?.["next-step"]) ||
                inbox["next-turn"].length ||
                inbox["next-step"].length
              )
                quiescent = false;
            } finally {
              observed[Symbol.dispose]?.();
            }
          }
        }
        const laterStart =
          end && events.some((e) => e.type === "turn/start" && e.seq > end.seq);
        return {
          terminal: !!end && !laterStart,
          quiescent,
          ...(user ? { userSeq: user.seq } : {}),
          ...(end ? { terminalSeq: end.seq } : {}),
        };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
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

// The host owner can disable any plugin; this is a managed-session capability
// boundary, not an OS sandbox or protection against a malicious host plugin.
export function guardManagedTools(ctx, service) {
  if (service.runtime.safetySupported !== true) return () => {};
  const recordFor = (agent) =>
    [...service.records.values()].find(
      (r) =>
        r.safetyVersion === 1 &&
        (r.sessionId === agent?.id ||
          r.descendantSessionIds?.includes(agent?.id) ||
          service.runtime.ownsAgent?.(
            agent,
            r.sessionId,
            r.descendantSessionIds,
          ) === true),
    );
  const unguard = ctx.tools.guard((exec) => {
    const record = recordFor(exec.agent);
    if (!record) return;
    if (record.state !== "ready" || record.activeRun?.state !== "running")
      return "Managed task has no admitted source lease. Continue through Agent Dispatch Hub.";
    if (
      record.capability === "readonly" &&
      service.runtime.readonlyAllowed?.(exec) !== true
    )
      return "Readonly dispatch permits only native read, glob and grep tools.";
  });
  const created = ctx.on("agent/created", async ({ agent }) => {
    const record = recordFor(agent);
    if (
      record &&
      agent.id !== record.sessionId &&
      !record.descendantSessionIds?.includes(agent.id)
    ) {
      if (!/^session-[a-f0-9-]{36}$/.test(agent.id))
        throw new Error("Unrecognized managed descendant identity.");
      (record.descendantSessionIds ??= []).push(agent.id);
      await service.save(record);
    }
    if (record?.state === "ready" && record.capability === "readonly")
      await service.runtime.configureReadonly(agent.id);
  });
  return () => {
    created?.();
    unguard();
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
