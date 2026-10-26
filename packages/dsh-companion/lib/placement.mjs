// Placement v2 pure config/path validator (docs/PLACEMENT-V2.md).
// No third-party deps, no host filesystem access, no host path resolution:
// every target-machine path is handled through the explicitly selected
// path.win32 / path.posix pair.
import path from "node:path";

export const PATH_STYLES = ["win32", "posix"];
const EXECUTION_MODES = ["fixed", "subdirectory"];
const ON_MISSING = ["error", "create"];
const ENFORCEMENT = ["instructions"];
const UNSUPPORTED_ENFORCEMENT = ["sandbox-required"];
const TEMPLATE_PLACEHOLDERS = ["jobId", "date", "target", "mapping"];
const SCOPE_PLACEHOLDERS = ["taskCwd"];

const WIN32_FORBIDDEN_CHARS = /[<>|?*"]/;
const WIN32_RESERVED = /^(con|prn|aux|nul|com\d+|lpt\d+)$/i;
// Preview values are only used to validate a template's shape before dispatch;
// they never reach a plan, which substitutes the real job identity.
const TEMPLATE_PREVIEW = Object.freeze({
  jobId: "0",
  date: "1970-01-01",
  target: "t",
  mapping: "m",
});
const SCOPE_TASK_CWD_TOKEN = "{taskCwd}";
const SCOPE_PREVIEW_CWD = Object.freeze({
  posix: "/preview-0/0",
  win32: "C:\\preview-0\\0", // release-check:ignore synthetic target-path fixture
});
const ISO_NOW =
  /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2}))?$/;

export class PlacementError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "PlacementError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new PlacementError(code, message, field);
}

function pathsOf(pathStyle) {
  if (pathStyle === "win32") return path.win32;
  if (pathStyle === "posix") return path.posix;
  return null;
}

function requirePathStyle(pathStyle, field = "pathStyle") {
  if (typeof pathStyle !== "string" || !PATH_STYLES.includes(pathStyle)) {
    fail(
      "invalid-value",
      field,
      `${field} must be one of: ${PATH_STYLES.join(", ")}`,
    );
  }
}

function plainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-type", field, `${field} must be a plain object`);
  }
  return value;
}

function knownKeys(object, required, field) {
  for (const key of Object.keys(object)) {
    if (!required.includes(key))
      fail(
        "unknown-field",
        `${field}.${key}`,
        `unknown field "${key}" in ${field}`,
      );
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key))
      fail(
        "missing-field",
        `${field}.${key}`,
        `${field} is missing required field "${key}"`,
      );
  }
}

function nonEmptyString(value, field) {
  if (typeof value !== "string")
    fail("invalid-type", field, `${field} must be a string`);
  if (value.trim() === "")
    fail("invalid-value", field, `${field} must be a non-empty string`);
  if (/[\u0000-\u001f\u007f]/.test(value))
    fail(
      "invalid-value",
      field,
      `${field} must not contain control characters`,
    );
  return value;
}

function oneOf(value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(
      "invalid-value",
      field,
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value;
}

function explicitBoolean(value, field) {
  if (typeof value !== "boolean")
    fail("invalid-type", field, `${field} must be an explicit boolean`);
  return value;
}

function segmentList(value, pathStyle) {
  return pathStyle === "win32" ? value.split(/[\\/]/) : value.split("/");
}

/** Drop redundant trailing separators, keeping a bare root intact. */
function stripTrailing(value, pathStyle) {
  const trailing = pathStyle === "win32" ? /[\\/]+$/ : /\/+$/;
  const root = pathsOf(pathStyle).parse(value).root;
  let out = value;
  while (out.length > root.length && trailing.test(out))
    out = out.replace(trailing, "");
  return out;
}

/**
 * Canonicalize one target-machine path with that style's grammar only.
 * Traversal and ambiguous Windows spellings are rejected, never resolved.
 */
export function normalizeTargetPath(value, pathStyle) {
  requirePathStyle(pathStyle);
  const field = "path";
  const paths = pathsOf(pathStyle);
  const text = nonEmptyString(value, field);
  if (pathStyle === "win32") {
    if (text.startsWith("\\\\?\\"))
      fail(
        "win-device-path",
        field,
        `${field} uses the \\\\?\\ device namespace`,
      );
    if (text.startsWith("\\\\.\\"))
      fail(
        "win-device-path",
        field,
        `${field} uses the \\\\.\\ device namespace`,
      );
    if (text.startsWith("\\\\")) {
      const parts = text.slice(2).split(/[\\/]/).filter(Boolean);
      if (parts.length < 2)
        fail(
          "win-unc-incomplete",
          field,
          `${field} UNC path needs both a server and a share`,
        );
      if (parts.includes(".."))
        fail(
          "path-traversal",
          field,
          `${field} must not contain ".." segments`,
        );
      if (parts.some((part) => part.includes(":")))
        fail(
          "win-stream",
          field,
          `${field} UNC path must not contain a drive or stream colon`,
        );
    } else if (/^[a-zA-Z]:/.test(text)) {
      if (!/^[a-zA-Z]:[\\/]/.test(text))
        fail(
          "win-drive-relative",
          field,
          `${field} is drive-relative, not absolute`,
        );
      if (text.slice(2).includes(":"))
        fail(
          "win-stream",
          field,
          `${field} contains an alternate-data-stream colon`,
        );
    } else {
      fail(
        "not-absolute",
        field,
        `${field} must be drive-qualified (C:\\...) or UNC (\\\\server\\share\\...)`,
      );
    }
    if (!paths.isAbsolute(text))
      fail("not-absolute", field, `${field} must be a Windows absolute path`);
    if (WIN32_FORBIDDEN_CHARS.test(text))
      fail(
        "invalid-value",
        field,
        `${field} contains characters illegal on Windows`,
      );
    const segments = segmentList(text, pathStyle).filter(Boolean);
    if (segments.includes(".."))
      fail("path-traversal", field, `${field} must not contain ".." segments`);
    for (const segment of segments) {
      if (/[. ]$/.test(segment))
        fail(
          "win-trailing-dot-space",
          field,
          `${field} segments must not end with "." or space`,
        );
      if (WIN32_RESERVED.test(segment.split(".")[0]))
        fail(
          "win-reserved-name",
          field,
          `${field} uses the reserved name "${segment}"`,
        );
    }
    return stripTrailing(paths.normalize(text), pathStyle);
  }
  if (text.startsWith("\\\\"))
    fail(
      "win-path-on-posix",
      field,
      `${field} is a Windows UNC path, not a POSIX path`,
    );
  if (/^[a-zA-Z]:/.test(text))
    fail(
      "win-path-on-posix",
      field,
      `${field} is a Windows drive path, not a POSIX path`,
    );
  if (!text.startsWith("/"))
    fail("not-absolute", field, `${field} must start with "/"`);
  if (text.startsWith("//"))
    fail("not-absolute", field, `${field} must not start with a doubled slash`);
  if (!paths.isAbsolute(text))
    fail("not-absolute", field, `${field} must be a POSIX absolute path`);
  if (segmentList(text, pathStyle).includes(".."))
    fail("path-traversal", field, `${field} must not contain ".." segments`);
  return stripTrailing(paths.normalize(text), pathStyle);
}

function normalizeField(value, pathStyle, field) {
  try {
    return normalizeTargetPath(value, pathStyle);
  } catch (error) {
    if (error instanceof PlacementError) {
      throw new PlacementError(
        error.code,
        error.message.replace(/^path\b/, field),
        field,
      );
    }
    throw error;
  }
}

/** Directory-boundary containment. Windows comparison ignores case. */
export function isWithin(candidate, root, pathStyle) {
  requirePathStyle(pathStyle);
  const left = normalizeField(candidate, pathStyle, "isWithin.candidate");
  const right = normalizeField(root, pathStyle, "isWithin.root");
  if (pathStyle === "win32") {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a === b) return true;
    return b.endsWith("\\") ? a.startsWith(b) : a.startsWith(`${b}\\`);
  }
  if (left === right) return true;
  return right.endsWith("/")
    ? left.startsWith(right)
    : left.startsWith(`${right}/`);
}

function withinSome(candidate, roots, pathStyle) {
  return roots.some((root) => isWithin(candidate, root, pathStyle));
}

function safeSegment(value, field) {
  const text = nonEmptyString(value, field);
  if (text === "." || text === "..")
    fail("path-traversal", field, `${field} must not be "." or ".."`);
  if (/[\\/]/.test(text))
    fail("invalid-value", field, `${field} must be a single path segment`);
  return text;
}

function checkPlaceholders(text, allowed, field) {
  nonEmptyString(text, field);
  if (/[{}]/.test(text.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""))) {
    fail(
      "placeholder-malformed",
      field,
      `${field} must not contain stray or empty braces`,
    );
  }
  for (const match of text.matchAll(/\{([A-Za-z0-9]*)\}/g)) {
    if (!allowed.includes(match[1])) {
      fail(
        "placeholder-unknown",
        field,
        `${field} uses unsupported placeholder "{${match[1]}}"`,
      );
    }
  }
}

function substitute(text, values, field) {
  checkPlaceholders(text, Object.keys(values), field);
  return text.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (whole, name) => values[name],
  );
}

function validateDshWorkspace(value, pathStyle, field) {
  const object = plainObject(value, field);
  const hasId = Object.hasOwn(object, "id");
  const hasPath = Object.hasOwn(object, "path");
  if (hasId === hasPath)
    fail(
      "invalid-selector",
      field,
      `${field} must set exactly one of "id" or "path"`,
    );
  const required = hasId ? ["id", "onMissing"] : ["path", "onMissing"];
  const optional = hasId ? [] : ["title"];
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(
        "unknown-field",
        `${field}.${key}`,
        hasId && key === "title"
          ? `${field}.title is only accepted on a path selector: an id selector already names the workspace`
          : `unknown field "${key}" in ${field}`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key))
      fail(
        "missing-field",
        `${field}.${key}`,
        `${field} is missing required field "${key}"`,
      );
  }
  const onMissing = oneOf(object.onMissing, ON_MISSING, `${field}.onMissing`);
  if (hasId) {
    if (onMissing === "create") {
      fail(
        "invalid-selector",
        `${field}.onMissing`,
        'an id selector cannot use onMissing "create": registration needs a path',
      );
    }
    const id = safeSegment(
      nonEmptyString(object.id, `${field}.id`),
      `${field}.id`,
    );
    return Object.freeze({ id, onMissing });
  }
  const normalized = Object.freeze({
    path: normalizeField(object.path, pathStyle, `${field}.path`),
    onMissing,
  });
  if (!Object.hasOwn(object, "title")) return normalized;
  const title = nonEmptyString(object.title, `${field}.title`);
  if (title.length > 200)
    fail(
      "invalid-value",
      `${field}.title`,
      `${field}.title must be at most 200 characters`,
    );
  return Object.freeze({ ...normalized, title });
}

function validateExecution(value, pathStyle, field) {
  const object = plainObject(value, field);
  const mode = oneOf(object.mode, EXECUTION_MODES, `${field}.mode`);
  const create = explicitBoolean(object.create, `${field}.create`);
  if (mode === "fixed") {
    knownKeys(object, ["mode", "cwd", "create"], field);
    return {
      mode,
      cwd: normalizeField(object.cwd, pathStyle, `${field}.cwd`),
      create,
    };
  }
  knownKeys(object, ["mode", "root", "template", "create"], field);
  const template = nonEmptyString(object.template, `${field}.template`);
  checkPlaceholders(template, TEMPLATE_PLACEHOLDERS, `${field}.template`);
  if (!template.includes("{jobId}")) {
    fail(
      "placeholder-required",
      `${field}.template`,
      `${field}.template must contain "{jobId}" so every job owns one directory`,
    );
  }
  const root = normalizeField(object.root, pathStyle, `${field}.root`);
  // Preview the shape now, so a template that cannot name one legal child
  // directory is a configuration error instead of a dispatch-time surprise.
  const paths = pathsOf(pathStyle);
  const segment = safeSegment(
    template.replace(
      /\{([A-Za-z][A-Za-z0-9]*)\}/g,
      (whole, name) => TEMPLATE_PREVIEW[name],
    ),
    `${field}.template`,
  );
  const previewCwd = normalizeField(
    paths.join(root, segment),
    pathStyle,
    `${field}.template`,
  );
  if (!isWithin(previewCwd, root, pathStyle)) {
    fail(
      "constraint-violation",
      `${field}.template`,
      `template ${template} does not resolve to a child of execution.root`,
    );
  }
  return { mode, root, template, create };
}

function validateSource(value, pathStyle, field) {
  const object = plainObject(value, field);
  knownKeys(object, ["root"], field);
  return { root: normalizeField(object.root, pathStyle, `${field}.root`) };
}

function validateScope(value, pathStyle, field) {
  const object = plainObject(value, field);
  knownKeys(object, ["read", "write", "enforcement"], field);
  if (
    typeof object.enforcement === "string" &&
    UNSUPPORTED_ENFORCEMENT.includes(object.enforcement)
  ) {
    fail(
      "unsupported",
      `${field}.enforcement`,
      'enforcement "sandbox-required" is unsupported: DSH groups sessions but does not confine these ranges',
    );
  }
  oneOf(object.enforcement, ENFORCEMENT, `${field}.enforcement`);
  const previewCwd = SCOPE_PREVIEW_CWD[pathStyle];
  const list = (key) => {
    const entries = object[key];
    if (!Array.isArray(entries) || entries.length === 0) {
      fail(
        "invalid-type",
        `${field}.${key}`,
        `${field}.${key} must be a non-empty array`,
      );
    }
    return entries.map((entry, index) => {
      const at = `${field}.${key}[${index}]`;
      const text = nonEmptyString(entry, at);
      checkPlaceholders(text, SCOPE_PLACEHOLDERS, at);
      if (!text.includes(SCOPE_TASK_CWD_TOKEN)) {
        normalizeField(text, pathStyle, at);
        return text;
      }
      // Validate against a safe preview directory now: a range that cannot be a
      // real path is a configuration error, never a dispatch-time surprise.
      if (text.split(SCOPE_TASK_CWD_TOKEN).length - 1 > 1) {
        fail("invalid-value", at, `${at} must repeat "{taskCwd}" at most once`);
      }
      if (!text.startsWith(SCOPE_TASK_CWD_TOKEN)) {
        fail(
          "invalid-value",
          at,
          `${at} must be "{taskCwd}" or a path below it`,
        );
      }
      const rest = text.slice(SCOPE_TASK_CWD_TOKEN.length);
      const separator = pathStyle === "win32" ? /^[\\/]/ : /^\//;
      if (rest !== "" && !separator.test(rest)) {
        fail(
          "invalid-value",
          at,
          `${at} must be "{taskCwd}" or a path below it`,
        );
      }
      const previewed = normalizeField(`${previewCwd}${rest}`, pathStyle, at);
      if (rest !== "" && !isWithin(previewed, previewCwd, pathStyle)) {
        fail("constraint-violation", at, `${at} must stay below "{taskCwd}"`);
      }
      return text;
    });
  };
  return {
    read: list("read"),
    write: list("write"),
    enforcement: object.enforcement,
  };
}

/** Validate one v2 workspace mapping against the instance path style. */
export function validateMapping(mapping, pathStyle) {
  requirePathStyle(pathStyle);
  const field = "mapping";
  const object = plainObject(mapping, field);
  knownKeys(object, ["dshWorkspace", "execution", "source", "scope"], field);
  return {
    dshWorkspace: validateDshWorkspace(
      object.dshWorkspace,
      pathStyle,
      `${field}.dshWorkspace`,
    ),
    execution: validateExecution(
      object.execution,
      pathStyle,
      `${field}.execution`,
    ),
    source: validateSource(object.source, pathStyle, `${field}.source`),
    scope: validateScope(object.scope, pathStyle, `${field}.scope`),
  };
}

/**
 * Normalize the plan instant to epoch milliseconds. A plan must carry one fixed
 * instant so a server rebuilding it cannot drift across a midnight boundary.
 */
export function normalizeNow(value) {
  const field = "now";
  if (value instanceof Date) {
    const epoch = value.getTime();
    if (!Number.isFinite(epoch) || epoch < 0)
      fail("invalid-value", field, "now must be a valid Date");
    return epoch;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      fail(
        "invalid-value",
        field,
        "now must be a non-negative epoch-millisecond integer",
      );
    return value;
  }
  if (typeof value === "string") {
    if (!ISO_NOW.test(value))
      fail("invalid-value", field, "now must be an ISO-8601 date or date-time");
    const parsed = new Date(value);
    const epoch = parsed.getTime();
    if (!Number.isFinite(epoch))
      fail("invalid-value", field, "now is not a real instant");
    return epoch;
  }
  fail(
    "invalid-type",
    field,
    "now must be a Date, an epoch-millisecond number, or an ISO-8601 string",
  );
}

function planDate(epoch) {
  return new Date(epoch).toISOString().slice(0, 10);
}

/** Resolve the frozen placement plan for one job. */
export function planPlacement({
  instance,
  mapping,
  targetName,
  mappingName,
  jobId,
  now,
} = {}) {
  const binding = validateTargetBinding(instance);
  const pathStyle = binding.pathStyle;
  const checked = validateMapping(mapping, pathStyle);
  const id = safeSegment(nonEmptyString(jobId, "jobId"), "jobId");
  const target = safeSegment(
    nonEmptyString(targetName, "targetName"),
    "targetName",
  );
  const mappingKey = safeSegment(
    nonEmptyString(mappingName, "mappingName"),
    "mappingName",
  );
  const instant = normalizeNow(now);
  const field = `workspaces.${mappingKey}.execution`;
  const paths = pathsOf(pathStyle);

  let requestedCwd;
  if (checked.execution.mode === "fixed") {
    requestedCwd = checked.execution.cwd;
  } else {
    const segment = safeSegment(
      substitute(
        checked.execution.template,
        { jobId: id, date: planDate(instant), target, mapping: mappingKey },
        `${field}.template`,
      ),
      `${field}.template`,
    );
    requestedCwd = normalizeField(
      paths.join(checked.execution.root, segment),
      pathStyle,
      `${field}.template`,
    );
    if (!isWithin(requestedCwd, checked.execution.root, pathStyle)) {
      fail(
        "constraint-violation",
        `${field}.template`,
        `generated task directory ${requestedCwd} is outside execution.root`,
      );
    }
  }

  const scopeField = `workspaces.${mappingKey}.scope`;
  const substituteScope = (entry, at) =>
    normalizeField(
      substitute(entry, { taskCwd: requestedCwd }, at),
      pathStyle,
      at,
    );
  const read = checked.scope.read.map((entry, index) =>
    substituteScope(entry, `${scopeField}.read[${index}]`),
  );
  const write = checked.scope.write.map((entry, index) =>
    substituteScope(entry, `${scopeField}.write[${index}]`),
  );

  if (!withinSome(requestedCwd, read, pathStyle)) {
    fail(
      "constraint-violation",
      `${scopeField}.read`,
      `task cwd ${requestedCwd} is outside every declared read range`,
    );
  }
  if (!withinSome(requestedCwd, write, pathStyle)) {
    fail(
      "constraint-violation",
      `${scopeField}.write`,
      `task cwd ${requestedCwd} is outside every declared write range`,
    );
  }
  write.forEach((root, index) => {
    if (!withinSome(root, read, pathStyle)) {
      fail(
        "constraint-violation",
        `${scopeField}.write[${index}]`,
        `write range ${root} is outside every declared read range`,
      );
    }
  });
  if (!withinSome(checked.source.root, read, pathStyle)) {
    fail(
      "constraint-violation",
      `workspaces.${mappingKey}.source.root`,
      `source root ${checked.source.root} is outside every declared read range`,
    );
  }

  return Object.freeze({
    instance: binding,
    dshWorkspace: checked.dshWorkspace,
    execution: Object.freeze({ ...checked.execution, requestedCwd }),
    source: Object.freeze(checked.source),
    scope: Object.freeze({
      read: Object.freeze(read),
      write: Object.freeze(write),
      enforcement: checked.scope.enforcement,
    }),
    targetName: target,
    mappingName: mappingKey,
    jobId: id,
    now: instant,
  });
}

/** Validate the per-target instance binding and return its normalized copy. */
export function validateTargetBinding(instance) {
  const field = "instance";
  const object = plainObject(instance, field);
  knownKeys(object, ["id", "pathStyle"], field);
  const id = nonEmptyString(object.id, `${field}.id`);
  if (id !== id.trim())
    fail(
      "invalid-value",
      `${field}.id`,
      `${field}.id must not have surrounding whitespace`,
    );
  if (id.length > 200)
    fail(
      "invalid-value",
      `${field}.id`,
      `${field}.id must be at most 200 characters`,
    );
  if (/[/\\]/.test(id))
    fail(
      "invalid-value",
      `${field}.id`,
      `${field}.id must not contain path separators`,
    );
  return Object.freeze({
    id,
    pathStyle: oneOf(object.pathStyle, PATH_STYLES, `${field}.pathStyle`),
  });
}
