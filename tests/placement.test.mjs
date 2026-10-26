import test from "node:test";
import assert from "node:assert/strict";
import {
  PlacementError,
  isWithin,
  normalizeTargetPath,
  planPlacement,
  validateMapping,
  validateTargetBinding,
} from "../packages/dsh-companion/lib/placement.mjs";

const POSIX_INSTANCE = Object.freeze({ id: "srv-a1b2", pathStyle: "posix" });
const WIN_INSTANCE = Object.freeze({ id: "desk-0001", pathStyle: "win32" });

function posixMapping(overrides = {}) {
  return structuredClone({
    dshWorkspace: { id: "ws-1", onMissing: "error" },
    execution: {
      mode: "subdirectory",
      root: "/absolute/tasks",
      template: "{date}-{jobId}",
      create: true,
    },
    source: { root: "/absolute/source/project" },
    scope: {
      read: ["/absolute/source/project", "{taskCwd}"],
      write: ["{taskCwd}"],
      enforcement: "instructions",
    },
    ...overrides,
  });
}

function winMapping(overrides = {}) {
  return structuredClone({
    dshWorkspace: { path: "D:\\Source\\Project", onMissing: "error" }, // release-check:ignore synthetic target-path fixture
    execution: {
      mode: "subdirectory",
      root: "D:\\Tasks", // release-check:ignore synthetic target-path fixture
      template: "job-{jobId}",
      create: true,
    },
    source: { root: "D:\\Source\\Project" }, // release-check:ignore synthetic target-path fixture
    scope: {
      read: ["D:\\Source\\Project", "{taskCwd}"], // release-check:ignore synthetic target-path fixture
      write: ["{taskCwd}"],
      enforcement: "instructions",
    },
    ...overrides,
  });
}

function base(overrides = {}) {
  return {
    instance: POSIX_INSTANCE,
    mapping: posixMapping(),
    targetName: "office",
    mappingName: "project",
    jobId: "job-7",
    now: new Date("2026-10-26T03:00:00Z"),
    ...overrides,
  };
}

function expectCode(code, action) {
  try {
    action();
  } catch (error) {
    assert.ok(
      error instanceof PlacementError,
      `expected PlacementError, got ${error}`,
    );
    assert.equal(error.code, code, `wrong code for: ${error.message}`);
    assert.ok(
      typeof error.field === "string" && error.field.length > 0,
      "PlacementError must carry a field",
    );
    return error;
  }
  assert.fail(`expected ${code} to be rejected`);
}

test("instance binding is strict about id and pathStyle", () => {
  assert.deepEqual(validateTargetBinding(POSIX_INSTANCE), POSIX_INSTANCE);
  expectCode("invalid-value", () =>
    validateTargetBinding({ id: "", pathStyle: "posix" }),
  );
  expectCode("invalid-value", () =>
    validateTargetBinding({ id: "   ", pathStyle: "posix" }),
  );
  expectCode("invalid-value", () =>
    validateTargetBinding({ id: "a/b", pathStyle: "posix" }),
  );
  expectCode("invalid-value", () =>
    validateTargetBinding({ id: " ws ", pathStyle: "posix" }),
  );
  expectCode("invalid-value", () =>
    validateTargetBinding({ id: "ws", pathStyle: "windows" }),
  );
  expectCode("invalid-value", () =>
    validateTargetBinding({ id: "ws", pathStyle: "POSIX" }),
  );
  expectCode("unknown-field", () =>
    validateTargetBinding({ id: "ws", pathStyle: "posix", default: true }),
  );
  expectCode("missing-field", () => validateTargetBinding({ id: "ws" }));
  expectCode("invalid-type", () => validateTargetBinding("ws"));
});

test("normalizeTargetPath uses the selected grammar and never the host", () => {
  assert.equal(
    normalizeTargetPath("/srv/deep//tasks/", "posix"),
    "/srv/deep/tasks",
  );
  assert.equal(normalizeTargetPath("/srv/./tasks", "posix"), "/srv/tasks");
  assert.equal(normalizeTargetPath("C:\\Tasks\\", "win32"), "C:\\Tasks"); // release-check:ignore synthetic target-path fixture
  assert.equal(normalizeTargetPath("c:/Tasks/sub", "win32"), "c:\\Tasks\\sub"); // release-check:ignore synthetic target-path fixture
  assert.equal(
    normalizeTargetPath("\\\\file.example\\share\\proj", "win32"), // release-check:ignore synthetic target-path fixture
    "\\\\file.example\\share\\proj", // release-check:ignore synthetic target-path fixture
  );
  assert.equal(normalizeTargetPath("/srv/任务 dir", "posix"), "/srv/任务 dir");
  expectCode("path-traversal", () =>
    normalizeTargetPath("/srv/tasks/../etc", "posix"),
  );
  expectCode("path-traversal", () =>
    normalizeTargetPath("C:\\Tasks\\..\\etc", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("path-traversal", () =>
    normalizeTargetPath("\\\\srv\\share\\a\\..\\b", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("not-absolute", () => normalizeTargetPath("srv/tasks", "posix"));
  expectCode("not-absolute", () => normalizeTargetPath("//srv/tasks", "posix"));
  expectCode("invalid-value", () =>
    normalizeTargetPath("srv\u0000tasks", "posix"),
  );
  expectCode("invalid-value", () => normalizeTargetPath("", "posix"));
  expectCode("invalid-type", () => normalizeTargetPath(null, "posix"));
  expectCode("invalid-type", () =>
    normalizeTargetPath(["/srv/tasks"], "posix"),
  );
  expectCode("win-path-on-posix", () =>
    normalizeTargetPath("C:\\Tasks", "posix"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-path-on-posix", () =>
    normalizeTargetPath("\\\\srv\\share", "posix"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("invalid-value", () => normalizeTargetPath("/srv/tasks", "plan9"));
});

test("Windows spellings that are never placement directories are rejected", () => {
  expectCode("win-drive-relative", () =>
    normalizeTargetPath("C:Tasks\\today", "win32"),
  );
  expectCode("not-absolute", () =>
    normalizeTargetPath("\\Tasks\\today", "win32"),
  );
  expectCode("win-device-path", () =>
    normalizeTargetPath("\\\\?\\D:\\Tasks", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-device-path", () =>
    normalizeTargetPath("\\\\.\\D:\\Tasks", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-stream", () =>
    normalizeTargetPath("D:\\Tasks\\report.md:hidden", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-stream", () =>
    normalizeTargetPath("\\\\srv\\share\\report.md:hidden", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-stream", () =>
    normalizeTargetPath("\\\\srv:evil\\share", "win32"),
  );
  expectCode("invalid-value", () =>
    normalizeTargetPath('D:\\Tasks\\say "hi"', "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-unc-incomplete", () =>
    normalizeTargetPath("\\\\onlyserver", "win32"),
  );
  expectCode("win-reserved-name", () =>
    normalizeTargetPath("D:\\Tasks\\nul.log", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-reserved-name", () =>
    normalizeTargetPath("D:\\CON\\job", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-trailing-dot-space", () =>
    normalizeTargetPath("D:\\Tasks.\\job", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("win-trailing-dot-space", () =>
    normalizeTargetPath("D:\\Tasks\\job ", "win32"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("invalid-value", () =>
    normalizeTargetPath("D:\\Tasks\\a?b", "win32"), // release-check:ignore synthetic target-path fixture
  );
  assert.equal(
    normalizeTargetPath("\\\\srv\\share\\Tasks", "win32"), // release-check:ignore synthetic target-path fixture
    "\\\\srv\\share\\Tasks", // release-check:ignore synthetic target-path fixture
  );
});

test("isWithin compares directory boundaries, not raw prefixes", () => {
  assert.equal(isWithin("/tasks/job-1", "/tasks", "posix"), true);
  assert.equal(isWithin("/tasks/job-1/out.md", "/tasks", "posix"), true);
  assert.equal(isWithin("/tasks", "/tasks", "posix"), true);
  assert.equal(isWithin("/tasks/ab", "/tasks/a", "posix"), false);
  assert.equal(isWithin("/tasksmore", "/tasks", "posix"), false);
  assert.equal(isWithin("/tasks", "/tasks/", "posix"), true);
  assert.equal(isWithin("C:\\Tasks\\JOB-1", "c:\\tasks", "win32"), true); // release-check:ignore synthetic target-path fixture
  assert.equal(isWithin("C:\\Tasks\\ab", "C:\\Tasks\\a", "win32"), false); // release-check:ignore synthetic target-path fixture
  assert.equal(isWithin("c:\\tasks", "C:\\TASKS", "win32"), true); // release-check:ignore synthetic target-path fixture
  assert.equal(isWithin("/TASKS/job", "/tasks", "posix"), false);
  assert.equal(
    isWithin("\\\\srv\\share\\tasks\\job", "\\\\SRV\\share\\Tasks", "win32"), // release-check:ignore synthetic target-path fixture
    true,
  );
  assert.equal(isWithin("C:\\", "C:\\", "win32"), true);
  assert.equal(isWithin("C:\\Tasks", "C:\\", "win32"), true); // release-check:ignore synthetic target-path fixture
  expectCode("path-traversal", () =>
    isWithin("/tasks/../etc", "/srv", "posix"),
  );
});

test("mapping validation keeps the four concepts separate", () => {
  assert.deepEqual(validateMapping(posixMapping(), "posix").dshWorkspace, {
    id: "ws-1",
    onMissing: "error",
  });
  assert.deepEqual(validateMapping(winMapping(), "win32").dshWorkspace, {
    path: "D:\\Source\\Project", // release-check:ignore synthetic target-path fixture
    onMissing: "error",
  });
  expectCode("invalid-selector", () =>
    validateMapping(
      posixMapping({
        dshWorkspace: { id: "ws", path: "/absolute/tasks", onMissing: "error" },
      }),
      "posix",
    ),
  );
  expectCode("invalid-selector", () =>
    validateMapping(
      posixMapping({ dshWorkspace: { onMissing: "error" } }),
      "posix",
    ),
  );
  expectCode("invalid-selector", () =>
    validateMapping(
      posixMapping({ dshWorkspace: { id: "ws", onMissing: "create" } }),
      "posix",
    ),
  );
  expectCode("not-absolute", () =>
    validateMapping(
      posixMapping({
        dshWorkspace: { path: "relative/tasks", onMissing: "error" },
      }),
      "posix",
    ),
  );
  expectCode("unknown-field", () =>
    validateMapping(
      posixMapping({
        dshWorkspace: { id: "ws", onMissing: "error", title: "p" },
      }),
      "posix",
    ),
  );
  expectCode("unknown-field", () =>
    validateMapping({ ...posixMapping(), extra: {} }, "posix"),
  );
  expectCode("missing-field", () =>
    validateMapping(
      {
        dshWorkspace: { id: "ws", onMissing: "error" },
        execution: posixMapping().execution,
        source: posixMapping().source,
      },
      "posix",
    ),
  );
  expectCode("invalid-value", () => validateMapping(posixMapping(), "windows"));
});

test("execution modes, explicit create and template placeholders are enforced", () => {
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{jobId}",
        },
      }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{jobId}",
          create: "true",
        },
      }),
      "posix",
    ),
  );
  expectCode("placeholder-required", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{target}-{mapping}",
          create: true,
        },
      }),
      "posix",
    ),
  );
  expectCode("placeholder-unknown", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{sessionId}",
          create: true,
        },
      }),
      "posix",
    ),
  );
  expectCode("placeholder-malformed", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{job",
          create: true,
        },
      }),
      "posix",
    ),
  );
  expectCode("unknown-field", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "fixed",
          cwd: "/absolute/fixed",
          root: "/absolute/tasks",
          create: false,
        },
      }),
      "posix",
    ),
  );
  expectCode("missing-field", () =>
    validateMapping(
      posixMapping({
        execution: { mode: "fixed", create: false },
      }),
      "posix",
    ),
  );
  expectCode("invalid-value", () =>
    validateMapping(
      posixMapping({
        execution: {
          mode: "shared",
          root: "/absolute/tasks",
          template: "{jobId}",
          create: true,
        },
      }),
      "posix",
    ),
  );
});

test("scope declares ranges, is instruction-only, and never empty", () => {
  expectCode("unsupported", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: ["{taskCwd}"],
          enforcement: "sandbox-required",
        },
      }),
      "posix",
    ),
  );
  expectCode("missing-field", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: ["{taskCwd}"],
        },
      }),
      "posix",
    ),
  );
  expectCode("invalid-value", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: ["{taskCwd}"],
          enforcement: "sandbox",
        },
      }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        scope: { read: [], write: ["{taskCwd}"], enforcement: "instructions" },
      }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: [],
          enforcement: "instructions",
        },
      }),
      "posix",
    ),
  );
  expectCode("placeholder-unknown", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: ["/absolute/source/project", "{jobId}"],
          write: ["{taskCwd}"],
          enforcement: "instructions",
        },
      }),
      "posix",
    ),
  );
});

test("planPlacement substitutes, normalizes and freezes the whole plan", () => {
  const plan = planPlacement(base());
  assert.deepEqual(
    Object.keys(plan).sort(),
    [
      "dshWorkspace",
      "execution",
      "instance",
      "jobId",
      "mappingName",
      "now",
      "scope",
      "source",
      "targetName",
    ].sort(),
  );
  assert.equal(plan.now, Date.UTC(2026, 9, 26, 3, 0, 0));
  assert.equal(plan.execution.requestedCwd, "/absolute/tasks/2026-10-26-job-7");
  assert.equal(plan.execution.mode, "subdirectory");
  assert.equal(plan.execution.create, true);
  assert.deepEqual(plan.scope.read, [
    "/absolute/source/project",
    "/absolute/tasks/2026-10-26-job-7",
  ]);
  assert.deepEqual(plan.scope.write, ["/absolute/tasks/2026-10-26-job-7"]);
  assert.equal(plan.scope.enforcement, "instructions");
  assert.deepEqual(plan.instance, POSIX_INSTANCE);
  assert.equal(plan.jobId, "job-7");
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.scope.read));
});

test("planPlacement resolves Windows and UNC plans through win32 only", () => {
  const plan = planPlacement({
    instance: WIN_INSTANCE,
    now: Date.UTC(2026, 9, 26, 3),
    mapping: winMapping({
      execution: {
        mode: "subdirectory",
        root: "d:\\tasks", // release-check:ignore synthetic target-path fixture
        template: "{target}-{jobId}",
        create: true,
      },
    }),
    targetName: "office",
    mappingName: "project",
    jobId: "JOB-7",
  });
  assert.equal(plan.execution.requestedCwd, "d:\\tasks\\office-JOB-7"); // release-check:ignore synthetic target-path fixture
  assert.equal(
    isWithin(plan.execution.requestedCwd, "D:\\TASKS", "win32"), // release-check:ignore synthetic target-path fixture
    true,
  );
  assert.deepEqual(plan.scope.write, ["d:\\tasks\\office-JOB-7"]); // release-check:ignore synthetic target-path fixture

  const unc = planPlacement({
    instance: WIN_INSTANCE,
    now: "2026-10-26T03:00:00Z",
    mapping: winMapping({
      dshWorkspace: { path: "\\\\file\\share\\Source", onMissing: "create" }, // release-check:ignore synthetic target-path fixture
      execution: {
        mode: "subdirectory",
        root: "\\\\file\\share\\Tasks", // release-check:ignore synthetic target-path fixture
        template: "job-{jobId}",
        create: true,
      },
      source: { root: "\\\\file\\share\\Source" }, // release-check:ignore synthetic target-path fixture
      scope: {
        read: ["\\\\file\\share\\Source", "{taskCwd}"], // release-check:ignore synthetic target-path fixture
        write: ["{taskCwd}"],
        enforcement: "instructions",
      },
    }),
    targetName: "office",
    mappingName: "project",
    jobId: "job-9",
  });
  assert.equal(unc.execution.requestedCwd, "\\\\file\\share\\Tasks\\job-job-9"); // release-check:ignore synthetic target-path fixture
  assert.equal(unc.now, Date.UTC(2026, 9, 26, 3));
});

test("a fixed plan keeps its directory and never implies creation", () => {
  const plan = planPlacement({
    ...base(),
    mapping: posixMapping({
      execution: {
        mode: "fixed",
        cwd: "/absolute/tasks/shared-build",
        create: false,
      },
      scope: {
        read: ["/absolute/source/project", "/absolute/tasks"],
        write: ["/absolute/tasks/shared-build"],
        enforcement: "instructions",
      },
    }),
  });
  assert.equal(plan.execution.requestedCwd, "/absolute/tasks/shared-build");
  assert.equal(plan.execution.create, false);
});

test("every job gets one unique single-segment task directory", () => {
  const one = planPlacement(base({ jobId: "job-1" })).execution.requestedCwd;
  const two = planPlacement(base({ jobId: "job-2" })).execution.requestedCwd;
  assert.notEqual(one, two);
  assert.equal(
    one.split("/").length,
    "/absolute/tasks/2026-10-26-job-1".split("/").length,
  );
  assert.equal(
    planPlacement(base({ jobId: "job-1" })).execution.requestedCwd,
    one,
  );
  expectCode("path-traversal", () => planPlacement(base({ jobId: ".." })));
  expectCode("invalid-value", () => planPlacement(base({ jobId: "a/b" })));
  expectCode("invalid-value", () => planPlacement(base({ jobId: "C:\\evil" }))); // release-check:ignore synthetic target-path fixture
});

test("cross-placement traversal cannot escape execution.root", () => {
  expectCode("invalid-value", () =>
    planPlacement(base({ jobId: "../escape" })),
  );
  expectCode("path-traversal", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks/../etc",
          template: "{jobId}",
          create: true,
        },
      }),
    }),
  );
});

test("placement constraints must hold against the declared ranges", () => {
  expectCode("constraint-violation", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        scope: {
          read: ["/absolute/source/project"],
          write: ["/absolute/source/project"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  expectCode("constraint-violation", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: ["/absolute/tasks"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  expectCode("constraint-violation", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        scope: {
          read: ["/absolute/source/project"],
          write: ["/absolute/source/project", "{taskCwd}"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  expectCode("constraint-violation", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        source: { root: "/absolute/other" },
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: ["{taskCwd}"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  const loose = planPlacement({
    ...base(),
    mapping: posixMapping({
      execution: {
        mode: "subdirectory",
        root: "/absolute/tasksSibling",
        template: "{jobId}",
        create: true,
      },
    }),
  });
  assert.equal(loose.execution.requestedCwd, "/absolute/tasksSibling/job-7");
  assert.ok(
    isWithin(loose.execution.requestedCwd, loose.execution.root, "posix"),
  );
});

test("subdirectory task cwd always stays inside execution.root", () => {
  const paths = ["/absolute/tasks", "/absolute/tasks/"];
  for (const root of paths) {
    const plan = planPlacement({
      ...base(),
      mapping: posixMapping({
        execution: {
          mode: "subdirectory",
          root,
          template: "{target}-{mapping}-{jobId}",
          create: true,
        },
      }),
    });
    assert.ok(isWithin(plan.execution.requestedCwd, root, "posix"));
  }
  expectCode("invalid-value", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{jobId}/../escape",
          create: true,
        },
      }),
    }),
  );
  expectCode("invalid-value", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{jobId}/../../etc",
          create: true,
        },
      }),
    }),
  );
});

test("fixed execution also needs a readable and writable task directory", () => {
  const plan = planPlacement({
    ...base(),
    mapping: posixMapping({
      execution: { mode: "fixed", cwd: "/absolute/tasks/fx", create: true },
      scope: {
        read: ["/absolute/source/project", "/absolute/tasks"],
        write: ["/absolute/tasks/fx"],
        enforcement: "instructions",
      },
    }),
  });
  assert.equal(plan.execution.requestedCwd, "/absolute/tasks/fx");
  expectCode("constraint-violation", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        execution: { mode: "fixed", cwd: "/absolute/elsewhere", create: true },
        scope: {
          read: ["/absolute/source/project", "/absolute/tasks"],
          write: ["/absolute/tasks"],
          enforcement: "instructions",
        },
      }),
    }),
  );
});

test("the instance path style owns every path in the mapping", () => {
  expectCode("not-absolute", () =>
    planPlacement({
      ...base(),
      instance: WIN_INSTANCE,
      mapping: winMapping({
        dshWorkspace: { path: "/absolute/tasks", onMissing: "error" },
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{jobId}",
          create: true,
        },
        source: { root: "/absolute/source/project" },
        scope: {
          read: ["/absolute/source/project", "{taskCwd}"],
          write: ["{taskCwd}"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  expectCode("win-path-on-posix", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({ source: { root: "D:\\Source\\Project" } }), // release-check:ignore synthetic target-path fixture
    }),
  );
});

test("malformed mapping shapes fail closed instead of guessing", () => {
  expectCode("invalid-type", () => validateMapping(null, "posix"));
  expectCode("invalid-type", () =>
    validateMapping(posixMapping({ execution: "/absolute/tasks" }), "posix"),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({ source: ["/absolute/source/project"] }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({ scope: "/absolute/source/project" }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: ["/absolute/source/project", 7],
          write: ["{taskCwd}"],
          enforcement: "instructions",
        },
      }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        scope: {
          read: "/absolute/source/project",
          write: ["{taskCwd}"],
          enforcement: "instructions",
        },
      }),
      "posix",
    ),
  );
});

test("the planner honors Windows case-insensitivity across ranges", () => {
  const plan = planPlacement({
    instance: WIN_INSTANCE,
    now: 1_793_850_000_000,
    mapping: winMapping({
      execution: {
        mode: "subdirectory",
        root: "D:\\Tasks", // release-check:ignore synthetic target-path fixture
        template: "{mapping}-{jobId}",
        create: true,
      },
      source: { root: "d:\\source\\project" }, // release-check:ignore synthetic target-path fixture
      scope: {
        read: ["D:\\SOURCE\\PROJECT", "{taskCwd}"], // release-check:ignore synthetic target-path fixture
        write: ["d:\\tasks\\project-job-7"], // release-check:ignore synthetic target-path fixture
        enforcement: "instructions",
      },
    }),
    targetName: "office",
    mappingName: "project",
    jobId: "job-7",
  });
  assert.equal(plan.execution.requestedCwd, "D:\\Tasks\\project-job-7"); // release-check:ignore synthetic target-path fixture
  assert.equal(
    isWithin("d:\\tasks\\project-job-7", plan.execution.requestedCwd, "win32"), // release-check:ignore synthetic target-path fixture
    true,
  );
});

test("generated segments obey the target style's own name rules", () => {
  const winJob = (jobId) =>
    planPlacement({
      instance: WIN_INSTANCE,
      now: Date.UTC(2026, 9, 26, 3),
      mapping: winMapping({
        execution: {
          mode: "subdirectory",
          root: "D:\\Tasks", // release-check:ignore synthetic target-path fixture
          template: "{jobId}",
          create: true,
        },
      }),
      targetName: "office",
      mappingName: "project",
      jobId,
    });
  expectCode("win-reserved-name", () => winJob("NUL"));
  expectCode("win-reserved-name", () => winJob("con.log"));
  expectCode("win-trailing-dot-space", () => winJob("job-7."));
  expectCode("invalid-value", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        execution: {
          mode: "subdirectory",
          root: "/absolute/tasks",
          template: "{jobId}",
          create: true,
        },
      }),
      jobId: "job-7\u0000",
    }),
  );
});

test("now is accepted as Date, epoch or ISO string and always returned as epoch", () => {
  const epoch = Date.UTC(2026, 9, 26, 3, 0, 0);
  for (const value of [
    new Date(epoch),
    epoch,
    "2026-10-26T03:00:00Z",
    "2026-10-26",
  ]) {
    const plan = planPlacement(base({ now: value }));
    assert.equal(
      plan.now,
      value === "2026-10-26" ? Date.UTC(2026, 9, 26) : epoch,
    );
    assert.equal(typeof plan.now, "number");
  }
  const midnight = base({ now: "2026-10-26T23:59:59Z" });
  const after = base({ now: "2026-10-27T00:00:01Z" });
  assert.equal(
    planPlacement(midnight).execution.requestedCwd,
    "/absolute/tasks/2026-10-26-job-7",
  );
  assert.equal(
    planPlacement(after).execution.requestedCwd,
    "/absolute/tasks/2026-10-27-job-7",
  );
  assert.equal(
    planPlacement(midnight).execution.requestedCwd,
    "/absolute/tasks/2026-10-26-job-7",
  );
  assert.equal(
    planPlacement({ ...midnight, now: Date.UTC(2026, 9, 26, 23, 59, 59) })
      .execution.requestedCwd,
    planPlacement(midnight).execution.requestedCwd,
  );
  expectCode("invalid-type", () => planPlacement(base({ now: undefined })));
  expectCode("invalid-type", () => planPlacement(base({ now: true })));
  expectCode("invalid-value", () => planPlacement(base({ now: -1 })));
  expectCode("invalid-value", () => planPlacement(base({ now: 1.5 })));
  expectCode("invalid-value", () => planPlacement(base({ now: Number.NaN })));
  expectCode("invalid-value", () => planPlacement(base({ now: "26/10/2026" })));
  expectCode("invalid-value", () =>
    planPlacement(base({ now: "2026-13-45T00:00:00Z" })),
  );
  expectCode("invalid-value", () =>
    planPlacement(base({ now: new Date("nope") })),
  );
});

test("a path selector may carry an optional title, an id selector may not", () => {
  const titled = validateMapping(
    posixMapping({
      dshWorkspace: {
        path: "/absolute/tasks",
        onMissing: "error",
        title: "项目 A",
      },
    }),
    "posix",
  );
  assert.deepEqual(titled.dshWorkspace, {
    path: "/absolute/tasks",
    onMissing: "error",
    title: "项目 A",
  });
  assert.deepEqual(
    validateMapping(
      posixMapping({
        dshWorkspace: { path: "/absolute/tasks", onMissing: "error" },
      }),
      "posix",
    ).dshWorkspace,
    { path: "/absolute/tasks", onMissing: "error" },
  );
  expectCode("unknown-field", () =>
    validateMapping(
      posixMapping({
        dshWorkspace: { id: "ws-1", onMissing: "error", title: "项目 A" },
      }),
      "posix",
    ),
  );
  expectCode("invalid-value", () =>
    validateMapping(
      posixMapping({
        dshWorkspace: {
          path: "/absolute/tasks",
          onMissing: "error",
          title: "  ",
        },
      }),
      "posix",
    ),
  );
  expectCode("invalid-type", () =>
    validateMapping(
      posixMapping({
        dshWorkspace: { path: "/absolute/tasks", onMissing: "error", title: 7 },
      }),
      "posix",
    ),
  );
  const plan = planPlacement(
    base({
      mapping: posixMapping({
        dshWorkspace: {
          path: "/absolute/tasks",
          onMissing: "create",
          title: "Project A",
        },
        source: { root: "/absolute/tasks" },
        scope: {
          read: ["/absolute/source/project", "/absolute/tasks"],
          write: ["/absolute/tasks"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  assert.deepEqual(plan.dshWorkspace, {
    path: "/absolute/tasks",
    onMissing: "create",
    title: "Project A",
  });
});

test("validateMapping rejects a template or range that cannot name a real directory", () => {
  const posixSubdirectory = (template) =>
    posixMapping({
      execution: {
        mode: "subdirectory",
        root: "/absolute/tasks",
        template,
        create: true,
      },
    });
  const winSubdirectory = (template) =>
    winMapping({
      execution: {
        mode: "subdirectory",
        root: "D:\\Tasks", // release-check:ignore synthetic target-path fixture
        template,
        create: true,
      },
    });
  expectCode("invalid-value", () =>
    validateMapping(posixSubdirectory("{jobId}/nested"), "posix"),
  );
  expectCode("invalid-value", () =>
    validateMapping(posixSubdirectory("{jobId}/../escape"), "posix"),
  );
  expectCode("invalid-value", () =>
    validateMapping(posixSubdirectory("{jobId}\u0000"), "posix"),
  );
  expectCode("win-trailing-dot-space", () =>
    validateMapping(winSubdirectory("{jobId}."), "win32"),
  );
  expectCode("win-trailing-dot-space", () =>
    validateMapping(winSubdirectory("{jobId} "), "win32"),
  );
  expectCode("invalid-value", () =>
    validateMapping(winSubdirectory("{jobId}?"), "win32"),
  );
  expectCode("invalid-value", () =>
    validateMapping(winSubdirectory('{jobId}"'), "win32"),
  );
  expectCode("win-stream", () =>
    validateMapping(winSubdirectory("{jobId}:stream"), "win32"),
  );
  expectCode("not-absolute", () =>
    validateMapping(
      {
        ...winSubdirectory("{jobId}"),
        execution: {
          mode: "subdirectory",
          root: "Tasks",
          template: "{jobId}",
          create: true,
        },
      },
      "win32",
    ),
  );

  const posixWrite = (ranges) =>
    posixMapping({
      scope: {
        read: ["/absolute/source/project", "{taskCwd}"],
        write: ranges,
        enforcement: "instructions",
      },
    });
  const winWrite = (ranges) =>
    winMapping({
      scope: {
        read: ["D:\\Source\\Project", "{taskCwd}"], // release-check:ignore synthetic target-path fixture
        write: ranges,
        enforcement: "instructions",
      },
    });
  expectCode("invalid-value", () =>
    validateMapping(posixWrite(["tasks/{taskCwd}"]), "posix"),
  );
  expectCode("invalid-value", () =>
    validateMapping(posixWrite(["prefix{taskCwd}"]), "posix"),
  );
  expectCode("invalid-value", () =>
    validateMapping(posixWrite(["{taskCwd}suffix"]), "posix"),
  );
  expectCode("invalid-value", () =>
    validateMapping(posixWrite(["{taskCwd}{taskCwd}"]), "posix"),
  );
  expectCode("path-traversal", () =>
    validateMapping(posixWrite(["{taskCwd}/../escape"]), "posix"),
  );
  expectCode("not-absolute", () =>
    validateMapping(posixWrite(["relative/tasks"]), "posix"),
  );
  expectCode("win-path-on-posix", () =>
    validateMapping(posixWrite(["D:\\Source\\Project"]), "posix"), // release-check:ignore synthetic target-path fixture
  );
  expectCode("invalid-value", () =>
    validateMapping(winWrite(["{taskCwd}suffix"]), "win32"),
  );
  expectCode("path-traversal", () =>
    validateMapping(winWrite(["{taskCwd}\\..\\escape"]), "win32"),
  );
  assert.deepEqual(
    validateMapping(winWrite(["{taskCwd}\\out"]), "win32").scope.write,
    ["{taskCwd}\\out"],
  );
});

test("ranges gate the plan on directory boundaries, not raw prefixes", () => {
  expectCode("constraint-violation", () =>
    planPlacement({
      ...base(),
      mapping: posixMapping({
        scope: {
          read: ["/absolute/source/project", "/absolute/tasks/job-7"],
          write: ["/absolute/tasks/job-7more"],
          enforcement: "instructions",
        },
      }),
    }),
  );
  const nested = planPlacement({
    ...base(),
    mapping: posixMapping({
      scope: {
        read: ["/absolute/source/project", "/absolute/tasks"],
        write: ["/absolute/tasks/2026-10-26-job-7"],
        enforcement: "instructions",
      },
    }),
  });
  assert.deepEqual(nested.scope.write, ["/absolute/tasks/2026-10-26-job-7"]);
});
