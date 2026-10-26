import { access, mkdtemp, readFile, rm, open, unlink } from "node:fs/promises";
import { join, basename, resolve, relative, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseDocument, isMap, isSeq } from "yaml";
import { parse as parseToml } from "smol-toml";
import {
  absolute,
  atomicWrite,
  backup,
  checked,
  defaultRunner,
  installError,
  readOptional,
  windowsInventory,
} from "./shared.mjs";
import { nativeExeFromCli } from "./discovery.mjs";

export const HUB_MCP_DENY = [
  "agent-dispatch-hub",
  "dsh-local-bridge",
  "codex-dsh-bridge",
];
const pluginIds = new Map([
  ["dsh-codex-sync", "codex-sync"],
  ["codex-dsh-bridge-companion", "codex-dsh-bridge"],
]);
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function mergeMap(target, incoming) {
  if (!isMap(incoming)) return;
  for (const pair of incoming.items) {
    const key = String(pair.key?.value ?? pair.key);
    const prior = target.get(key, true);
    if (isMap(prior) && isMap(pair.value)) mergeMap(prior, pair.value);
    else target.set(key, pair.value?.clone?.() ?? pair.value);
  }
}
/** Preserve YAML nodes/tags/comments, remove duplicate user insertions supplied by bundles. */
export function mergeCompanionPatch(text, denyNames = HUB_MCP_DENY) {
  const document = parseDocument(text ?? "[]\n", { uniqueKeys: true });
  if (document.errors.length || !isSeq(document.contents))
    throw installError(
      "DSH_PATCH_INVALID",
      "The DSH profile patch must be a valid YAML array.",
    );
  const configs = new Map();
  const attributes = new Map();
  const overrides = new Map();
  let changed = false;
  const targetId = (node) => {
    if (!isMap(node)) return undefined;
    const name = node.get("name");
    const id = node.get("id");
    return (
      pluginIds.get(name) ??
      ([...pluginIds.values()].includes(id) ? id : undefined)
    );
  };
  const collect = (id, node) => {
    const config = node.get("config", true);
    if (config !== undefined && !isMap(config))
      throw installError(
        "DSH_PATCH_UNSUPPORTED",
        "A companion configuration uses an unsupported YAML expression; edit it explicitly before setup.",
      );
    if (!configs.has(id)) configs.set(id, document.createNode({}));
    mergeMap(configs.get(id), config);
    if (!attributes.has(id)) attributes.set(id, document.createNode({}));
    for (const pair of node.items) {
      const key = String(pair.key?.value ?? pair.key);
      if (!["id", "name", "config"].includes(key))
        attributes.get(id).set(key, pair.value?.clone?.() ?? pair.value);
    }
  };
  for (let i = 0; i < document.contents.items.length; i++) {
    const row = document.contents.items[i];
    if (!isMap(row)) continue;
    const inserted = row.get("insert", true);
    if (isSeq(inserted)) {
      for (let j = 0; j < inserted.items.length; j++) {
        const id = targetId(inserted.items[j]);
        if (id) {
          collect(id, inserted.items[j]);
          inserted.items.splice(j--, 1);
          changed = true;
        }
      }
      if (!inserted.items.length) {
        row.delete("insert");
        if (!row.items.length) {
          document.contents.items.splice(i--, 1);
          continue;
        }
      }
    }
    const id = targetId(row);
    if (!id) continue;
    collect(id, row);
    if (overrides.has(id)) {
      mergeMap(overrides.get(id), row);
      document.contents.items.splice(i--, 1);
      changed = true;
    } else overrides.set(id, row);
  }
  const syncId = "codex-sync";
  if (!configs.has(syncId)) configs.set(syncId, document.createNode({}));
  const sync = configs.get(syncId);
  const denyNode = sync.get("mcpMirrorDeny", true);
  if (
    denyNode !== undefined &&
    (!isSeq(denyNode) ||
      denyNode.items.some((item) => typeof item?.value !== "string"))
  )
    throw installError(
      "DSH_PATCH_UNSUPPORTED",
      "mcpMirrorDeny must be an array of server names.",
    );
  const priorDeny = denyNode?.items.map((item) => item.value) ?? [];
  const mergedDeny = [...new Set([...priorDeny, ...denyNames])];
  if (JSON.stringify(priorDeny) !== JSON.stringify(mergedDeny)) {
    sync.set("mcpMirrorDeny", document.createNode(mergedDeny));
    changed = true;
  }
  for (const [id, config] of configs) {
    if (!overrides.has(id)) {
      const row = document.createNode({ id });
      mergeMap(row, attributes.get(id));
      row.set("config", config);
      document.contents.add(row);
      changed = true;
    } else {
      const row = overrides.get(id);
      const oldAttributes = row.toString();
      mergeMap(row, attributes.get(id));
      if (oldAttributes !== row.toString()) changed = true;
      const before = row.get("config", true)?.toString();
      row.set("config", config);
      if (before !== config.toString()) changed = true;
    }
  }
  return { changed, text: changed ? document.toString() : (text ?? "[]\n") };
}
// npm tarballs contain regular package files; understand PAX path and GNU longname
// records so comparisons stay valid for long plugin file names.
function tarFiles(bytes) {
  let archive;
  try {
    archive = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  } catch {
    throw installError(
      "PACKAGE_INVALID",
      "The packed companion archive is invalid.",
    );
  }
  const files = new Map();
  let nextName;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/su, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (
      !Number.isFinite(size) ||
      size < 0 ||
      offset + 512 + size > archive.length
    )
      throw installError(
        "PACKAGE_INVALID",
        "The packed companion archive is invalid.",
      );
    const data = archive.subarray(offset + 512, offset + 512 + size);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = nextName ?? (prefix ? `${prefix}/` : "") + field(0, 100);
    nextName = undefined;
    if (type === "L") nextName = data.toString().replace(/\0.*$/su, "");
    else if (type === "x") {
      const match = /(?:^|\n)\d+ path=([^\n]+)\n/u.exec(data.toString());
      if (match) nextName = match[1];
    } else if (type === "0" || type === "") {
      if (
        !name.startsWith("package/") ||
        name.includes("\\") ||
        name.split("/").includes("..")
      )
        throw installError(
          "PACKAGE_INVALID",
          "The packed companion archive contains an invalid path.",
        );
      files.set(name.slice(8), Buffer.from(data));
    } else if (!["5", "g"].includes(type))
      throw installError(
        "PACKAGE_INVALID",
        "The packed companion archive contains unsupported file entries.",
      );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function pack(checkout, destination, runner, npmCli) {
  const source = absolute(checkout, "checkout");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  } catch {
    throw installError(
      "DEPENDENCY_INVALID",
      "A companion checkout is missing valid package metadata.",
    );
  }
  if (!pluginIds.has(metadata.name))
    throw installError(
      "DEPENDENCY_INVALID",
      "The companion checkout has an unexpected package name.",
    );
  const output = await checked(
    runner,
    npmCli,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    { cwd: source, env: process.env },
    "PACKAGE_PACK_FAILED",
  );
  let filename;
  try {
    const result = JSON.parse(output.stdout);
    filename = result[0].filename;
  } catch {
    throw installError(
      "PACKAGE_PACK_FAILED",
      "npm did not return valid package metadata.",
    );
  }
  if (
    typeof filename !== "string" ||
    basename(filename) !== filename ||
    !filename.endsWith(".tgz")
  )
    throw installError(
      "PACKAGE_PACK_FAILED",
      "npm returned an invalid package filename.",
    );
  const path = join(destination, filename);
  const bytes = await readFile(path);
  const files = tarFiles(bytes);
  let packed;
  try {
    packed = JSON.parse(files.get("package.json").toString());
  } catch {
    throw installError(
      "PACKAGE_INVALID",
      "The packed companion is missing package metadata.",
    );
  }
  if (packed.name !== metadata.name || packed.version !== metadata.version)
    throw installError(
      "PACKAGE_INVALID",
      "The packed companion metadata does not match its checkout.",
    );
  return {
    path,
    name: metadata.name,
    version: metadata.version,
    sha256: sha(bytes),
    files,
  };
}
async function installedMatches(profileDir, pkg) {
  const root = join(profileDir, "node_modules", pkg.name);
  for (const [name, content] of pkg.files) {
    const path = resolve(root, name);
    if (relative(root, path).startsWith(`..${sep}`)) return false;
    try {
      if (sha(await readFile(path)) !== sha(content)) return false;
    } catch {
      return false;
    }
  }
  return pkg.files.size > 0;
}
async function discoverDenyAliases(codexHome) {
  const content = await readOptional(join(codexHome, "config.toml"));
  if (content === undefined) return [];
  let config;
  try {
    config = parseToml(content);
  } catch {
    throw installError(
      "CODEX_CONFIG_INVALID",
      "The existing Codex TOML is invalid.",
    );
  }
  return Object.entries(config.mcp_servers ?? {})
    .filter(([, srv]) => {
      const tokens = [
        srv?.command,
        ...(Array.isArray(srv?.args) ? srv.args : []),
      ].filter((value) => typeof value === "string");
      return tokens.some(
        (value) =>
          /(?:^|[\\/])(?:adh\.mjs|dsh-mcp-server\.mjs|agent-dispatch-hub|dsh-local-bridge)(?:\.cmd|\.exe)?$/iu.test(
            value,
          ) || /codex-dsh-bridge[\\/].*(?:mcp|server)/iu.test(value),
      );
    })
    .map(([name]) => name);
}
export async function installDshCompanions(options = {}) {
  const {
    profile = "desktop",
    runner = defaultRunner,
    dryRun = false,
  } = options;
  const dshHome = absolute(options.dshHome, "dshHome");
  const dshCli = absolute(options.dshCli, "dshCli");
  if (!/^[A-Za-z0-9_-]+$/u.test(profile))
    throw installError("INVALID_PROFILE", "The DSH profile name is invalid.");
  const profileDir = join(dshHome, "profiles", profile);
  const patchPath = join(profileDir, "cordis.patch.yml");
  const manifestPath = join(profileDir, "package.json");
  const connectionFile = join(dshHome, ".codex-dsh-bridge", "connection.json");
  if (!(await exists(manifestPath)))
    throw installError(
      "DSH_PROFILE_UNINITIALIZED",
      "Initialize the requested DSH profile before installing companions.",
      {
        action: profile === "desktop" ? "open-dsh-once" : "initialize-profile",
        profile,
      },
    );
  const temporary = await mkdtemp(join(tmpdir(), "adh-pack-"));
  try {
    const npmCli =
      options.npmCli ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    const packages = [
      await pack(options.syncCheckout, temporary, runner, npmCli),
      await pack(options.bridgeCheckout, temporary, runner, npmCli),
    ];
    const needed = [];
    for (const pkg of packages)
      if (!(await installedMatches(profileDir, pkg))) needed.push(pkg);
    const manifestText = await readOptional(manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      throw installError(
        "DSH_PROFILE_INVALID",
        "The DSH profile manifest is invalid.",
      );
    }
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles))
      throw installError(
        "DSH_PROFILE_INVALID",
        "The DSH profile bundle list is invalid.",
      );
    // A matching package without its bundle entry is still an incomplete install.
    for (const pkg of packages)
      if (!bundles.includes(pkg.name) && !needed.includes(pkg))
        needed.push(pkg);
    const targetNames = new Set(packages.map((pkg) => pkg.name));
    const normalizeBundles = (values) => {
      const seen = new Set();
      const normalized = values.filter((name) => {
        if (!targetNames.has(name)) return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
      for (const pkg of packages)
        if (!seen.has(pkg.name)) normalized.push(pkg.name);
      return normalized;
    };
    const bundleChange =
      JSON.stringify(bundles) !== JSON.stringify(normalizeBundles(bundles));
    const aliases = await discoverDenyAliases(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    );
    const originalPatch = await readOptional(patchPath);
    const patch = mergeCompanionPatch(originalPatch, [
      ...HUB_MCP_DENY,
      ...(options.mcpNames ?? []),
      ...aliases,
    ]);
    const changed = needed.length > 0 || patch.changed || bundleChange;
    const result = {
      changed,
      backups: [],
      connectionFile,
      needsRestart: changed,
      profileDir,
      packages: packages.map(({ name, version, sha256 }) => ({
        name,
        version,
        sha256,
      })),
      ...(dryRun ? { dryRun: true } : {}),
    };
    if (!changed || dryRun) return result;
    const appExe = options.appExe ?? nativeExeFromCli(dshCli);
    let running = options.running;
    if (running === undefined && process.platform === "win32" && appExe) {
      const inventory = await windowsInventory(runner);
      running = (
        Array.isArray(inventory.running)
          ? inventory.running
          : [inventory.running]
      )
        .filter(Boolean)
        .some((path) => path.toLowerCase() === appExe.toLowerCase());
    }
    if (running && (profile === "desktop" || appExe))
      throw installError(
        "DSH_RUNNING",
        "Quit DeepSeek Harness completely, then rerun setup to install the prepared companions.",
        { action: "quit-dsh", profile },
      );
    // Share Desktop's lifecycle lock during installation. Do not remove stale or
    // unknown locks, and do not bypass the package manager by running pnpm.
    if (profile === "desktop" && (await exists(join(profileDir, "lock"))))
      throw installError(
        "DSH_PROFILE_BUSY",
        "The desktop profile is locked; quit DeepSeek Harness before setup.",
        { action: "quit-dsh", profile },
      );
    const lockPath = join(profileDir, ".agent-dispatch-hub-install.lock");
    let lock;
    let desktopLock;
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(`${process.pid}\n`);
      if (profile === "desktop") {
        desktopLock = await open(join(profileDir, "lock"), "wx", 0o600);
        await desktopLock.writeFile(`${process.pid}\n`);
      }
    } catch {
      if (desktopLock) {
        await desktopLock.close();
        await unlink(join(profileDir, "lock")).catch(() => {});
      }
      if (lock) {
        await lock.close();
        await unlink(lockPath).catch(() => {});
      }
      throw installError(
        "DSH_PROFILE_BUSY",
        "Another setup or DSH lifecycle operation owns this profile.",
      );
    }
    try {
      if (
        (await readOptional(patchPath)) !== originalPatch ||
        (await readOptional(manifestPath)) !== manifestText
      )
        throw installError(
          "CONFIG_CHANGED",
          "The DSH profile changed during setup; retry setup.",
        );
      for (const file of [
        "package.json",
        "cordis.patch.yml",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ]) {
        const copy = await backup(join(profileDir, file));
        if (copy) result.backups.push(copy);
      }
      // Install each prepared archive using the selected profile and exact home.
      // Never use --ignore-scripts here: the DSH manager owns compatibility checks
      // and build approvals. These two packed source packages have no prepare hook.
      if (needed.length) {
        const archives = [];
        for (const pkg of needed) {
          const destination = join(
            dshHome,
            ".agent-dispatch-hub",
            "packages",
            `${pkg.sha256}.tgz`,
          );
          if (!(await exists(destination)))
            await atomicWrite(destination, await readFile(pkg.path));
          else if (sha(await readFile(destination)) !== pkg.sha256)
            throw installError(
              "PACKAGE_CACHE_CONFLICT",
              "A cached companion archive does not match its expected content.",
            );
          archives.push(destination);
        }
        await checked(
          runner,
          dshCli,
          ["plugin", "--profile", profile, "add", ...archives],
          { env: { ...process.env, DSH_HOME: dshHome } },
          "DSH_INSTALL_FAILED",
        );
        let installedManifest;
        try {
          installedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
        } catch {
          throw installError(
            "DSH_INSTALL_INVALID",
            "The package manager did not save a valid profile manifest.",
          );
        }
        for (const pkg of needed)
          if (!(await installedMatches(profileDir, pkg)))
            throw installError(
              "DSH_INSTALL_INVALID",
              "The package manager did not install the expected companion content.",
            );
      }
      // Native package management does not re-enable a retained dependency whose
      // bundle was removed earlier. Setup explicitly enables these companions,
      // preserving every other bundle and all unrelated manifest metadata.
      let after;
      try {
        after = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        throw installError(
          "DSH_INSTALL_INVALID",
          "The package manager did not save a valid profile manifest.",
        );
      }
      if (!Array.isArray(after.dsh?.profile?.bundles))
        throw installError(
          "DSH_INSTALL_INVALID",
          "The package manager did not save a valid profile bundle list.",
        );
      const normalized = normalizeBundles(after.dsh.profile.bundles);
      if (
        JSON.stringify(normalized) !== JSON.stringify(after.dsh.profile.bundles)
      ) {
        after.dsh.profile.bundles = normalized;
        await atomicWrite(manifestPath, `${JSON.stringify(after, null, 2)}\n`);
      }
      if (patch.changed) await atomicWrite(patchPath, patch.text);
      return result;
    } catch (error) {
      if (error.code) {
        error.details = { ...(error.details ?? {}), backups: result.backups };
        throw error;
      }
      throw installError(
        "DSH_INSTALL_FAILED",
        "Companion installation failed; profile backups are available.",
        undefined,
        { backups: result.backups },
      );
    } finally {
      if (desktopLock) {
        await desktopLock.close();
        await unlink(join(profileDir, "lock")).catch(() => {});
      }
      await lock.close();
      await unlink(lockPath).catch(() => {});
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
