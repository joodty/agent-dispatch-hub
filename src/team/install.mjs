import { join, isAbsolute, dirname } from "node:path";
import { mkdir, stat, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  atomicJson,
  readJson,
  privateDirectory,
  run,
  HubError,
  stateHome,
} from "../core/state.mjs";
import { repoRoot } from "../core/dependencies.mjs";

export async function installMessaging({
  service,
  memberId,
  profileDirectory,
}) {
  const state = await service.store.read(),
    member = state.members[memberId];
  if (
    member?.kind !== "dsh" ||
    !isAbsolute(profileDirectory ?? "") ||
    !(await stat(join(profileDirectory, "package.json"))).isFile()
  )
    throw new HubError(
      "messaging-install-config-required",
      "Choose a DSH member and that instance's explicit local profile directory.",
    );
  const credential = join(
    service.home,
    "team",
    "connections",
    member.id + ".json",
  );
  const connection = await readJson(credential);
  if (connection.memberId !== member.id || connection.token !== member.token)
    throw new HubError(
      "messaging-connection-missing",
      "Start team serve to publish this member's protected connection file first.",
    );
  const directory = join(profileDirectory, ".agent-dispatch-hub-messaging");
  stateHome(directory);
  const placementIdentity = await readJson(
    join(profileDirectory, ".agent-dispatch-hub-placement", "instance.json"),
    null,
  );
  if (placementIdentity && placementIdentity.id !== member.instance.id)
    throw new HubError(
      "messaging-profile-mismatch",
      "The supplied profile belongs to another DSH instance.",
    );
  await privateDirectory(directory);
  // Both processes are on this explicitly selected local machine. Keep a
  // protected pointer so a server restart can publish a new origin atomically.
  const targetFile = credential;
  const catalogFile = join(directory, "connections.json");
  const catalog = await readJson(catalogFile, { version: 1, connections: [] });
  if (catalog.version !== 1 || !Array.isArray(catalog.connections))
    throw new HubError(
      "messaging-config-conflict",
      "Existing messaging catalog is not managed by this installer.",
    );
  const old = catalog.connections.find((c) => c.projectId === member.projectId);
  if (old && old.connectionFile !== targetFile)
    throw new HubError(
      "messaging-config-conflict",
      "The project already references another connection file.",
    );
  await service.dsh.withMember(member, async (adapter) => {
    const plugins = await adapter.messagingPlugins();
    const existing = plugins.filter(
      (p) => p.moduleName === "agent-dispatch-hub-messaging",
    );
    if (existing.length > 1)
      throw new HubError(
        "messaging-plugin-ambiguous",
        "Multiple messaging plugin entries exist in the selected profile.",
      );
    if (existing.some((p) => !p.enabled || p.fiberPhase !== "active"))
      throw new HubError(
        "messaging-plugin-unavailable",
        "Existing messaging plugin is disabled or not active. Use the native plugin lifecycle; do not overwrite running code.",
      );
    if (existing.length === 0) {
      const packages = join(service.home, "team", "packages", randomUUID());
      await mkdir(packages, { recursive: true, mode: 0o700 });
      let npmCli;
      for (const candidate of [
        process.env.npm_execpath,
        join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ]) {
        if (
          candidate &&
          isAbsolute(candidate) &&
          candidate.endsWith("npm-cli.js")
        ) {
          try {
            await access(candidate);
            npmCli = candidate;
            break;
          } catch {}
        }
      }
      if (!npmCli)
        throw new HubError(
          "npm-runtime-required",
          "Use Node.js with its npm CLI, or run this command through npm so npm_execpath is available.",
        );
      const packArgs = [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packages,
      ];
      const packed = await run(process.execPath, packArgs, {
        cwd: join(repoRoot, "packages", "dsh-messaging"),
        windowsHide: true,
      });
      const file = JSON.parse(packed.stdout)[0]?.filename;
      if (
        typeof file !== "string" ||
        !/^agent-dispatch-hub-messaging-[\w.-]+\.tgz$/.test(file)
      )
        throw new HubError(
          "messaging-package-failed",
          "Cannot confirm the prepared messaging package.",
        );
      const requestId = randomUUID();
      await atomicJson(join(directory, "install-admission.json"), {
        requestId,
        spec: join(packages, file),
        memberId,
      });
      const result = await adapter.installMessaging({
        spec: join(packages, file),
        requestId,
      });
      if (result.error || result.restartRequired || result.applied === false)
        throw new HubError(
          "messaging-plugin-not-ready",
          "DSH requires native plugin lifecycle handling before messaging can be enabled.",
        );
    }
    const expected = await readJson(
      join(repoRoot, "packages", "dsh-messaging", "package.json"),
    );
    const installed = await readJson(
      join(
        profileDirectory,
        "node_modules",
        "agent-dispatch-hub-messaging",
        "package.json",
      ),
      null,
    );
    if (
      installed?.name !== expected.name ||
      installed.version !== expected.version
    )
      throw new HubError(
        "messaging-plugin-version-mismatch",
        "The selected local profile does not contain this messaging package version. Update through DSH's native lifecycle, without replacing running code.",
      );
  });
  if (!old)
    catalog.connections.push({
      projectId: member.projectId,
      connectionFile: targetFile,
    });
  await atomicJson(catalogFile, catalog);
  return {
    memberId,
    projectId: member.projectId,
    connectionFile: targetFile,
    catalogFile,
    installed: true,
    modelChanged: false,
  };
}
