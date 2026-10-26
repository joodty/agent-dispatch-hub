import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  discoverLocal,
  supportedDshVersion,
  mergeCompanionPatch,
  installDshCompanions,
  registerCodexMcp,
} from "../src/install/index.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "adh-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
function tar(files) {
  const blocks = [];
  for (const [name, source] of Object.entries(files)) {
    const content = Buffer.from(source);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write(content.length.toString(8).padStart(11, "0"), 124);
    header[156] = 48;
    blocks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function unpack(bytes) {
  const source = gunzipSync(bytes);
  const files = {};
  for (let position = 0; position + 512 <= source.length;) {
    const h = source.subarray(position, position + 512);
    if (h.every((value) => value === 0)) break;
    const name = h.subarray(0, 100).toString().replace(/\0.*$/su, "").slice(8);
    const size = Number.parseInt(
      h.subarray(124, 136).toString().replace(/\0.*$/su, "").trim(),
      8,
    );
    files[name] = source.subarray(position + 512, position + 512 + size);
    position += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function companionFixture(t) {
  const root = await fixture(t);
  const dshHome = join(root, "dsh");
  const profileDir = join(dshHome, "profiles", "desktop");
  const syncCheckout = join(root, "sync");
  const bridgeCheckout = join(root, "bridge");
  const codexHome = join(root, "codex");
  const dshCli = join(
    root,
    "native",
    "resources",
    "runtime",
    "cli",
    "bin",
    "dsh.cmd",
  );
  const calls = [];
  await put(
    join(profileDir, "package.json"),
    JSON.stringify({
      name: "my-profile",
      dependencies: { unrelated: "1.0.0" },
      dsh: { profile: { bundles: ["official", "unrelated"] } },
    }),
  );
  await put(
    join(profileDir, "cordis.patch.yml"),
    "# retained comment\n- id: unrelated\n  config:\n    custom: value\n",
  );
  for (const [dir, name] of [
    [syncCheckout, "dsh-codex-sync"],
    [bridgeCheckout, "codex-dsh-bridge-companion"],
  ]) {
    await put(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    await put(
      join(dir, "index.js"),
      `export const name = ${JSON.stringify(name)};\n`,
    );
  }
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === "pack") {
      const files = {
        "package.json": await readFile(
          join(options.cwd, "package.json"),
          "utf8",
        ),
        "index.js": await readFile(join(options.cwd, "index.js"), "utf8"),
      };
      const name = JSON.parse(files["package.json"]).name;
      const filename = `${name}.tgz`;
      await put(
        join(args[args.indexOf("--pack-destination") + 1], filename),
        tar(files),
      );
      return { stdout: JSON.stringify([{ filename }]), exitCode: 0 };
    }
    assert.equal(command, dshCli);
    assert.deepEqual(args.slice(0, 4), [
      "plugin",
      "--profile",
      "desktop",
      "add",
    ]);
    assert.equal(options.env.DSH_HOME, dshHome);
    const manifestPath = join(profileDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const archive of args.slice(4)) {
      assert.ok(
        archive.startsWith(join(dshHome, ".agent-dispatch-hub", "packages")),
      );
      const files = unpack(await readFile(archive));
      const pkg = JSON.parse(files["package.json"]);
      for (const [name, data] of Object.entries(files))
        await put(join(profileDir, "node_modules", pkg.name, name), data);
      manifest.dependencies[pkg.name] = `file:${archive}`;
      if (!manifest.dsh.profile.bundles.includes(pkg.name))
        manifest.dsh.profile.bundles.push(pkg.name);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    return { stdout: "", exitCode: 0 };
  };
  return {
    root,
    dshHome,
    profileDir,
    bridgeCheckout,
    syncCheckout,
    codexHome,
    dshCli,
    runner,
    calls,
    running: false,
  };
}

test("YAML merge preserves unrelated settings, removes duplicate insertions, and denies aliases", () => {
  const before =
    "# keep this\n- insert:\n    - id: codex-sync\n      name: dsh-codex-sync\n      config:\n        maxSkills: 42\n        mcpMirrorDeny: [existing]\n    - id: custom\n      name: custom-plugin\n- id: codex-sync\n  config:\n    enableSkills: false\n- id: codex-sync\n  config:\n    enableImport: false\n";
  const result = mergeCompanionPatch(before, ["agent-dispatch-hub", "alias"]);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("# keep this"));
  const rows = parseYaml(result.text);
  const sync = rows.filter((row) => row.id === "codex-sync");
  assert.equal(sync.length, 1);
  assert.equal(sync[0].config.maxSkills, 42);
  assert.equal(sync[0].config.enableSkills, false);
  assert.equal(sync[0].config.enableImport, false);
  assert.deepEqual(sync[0].config.mcpMirrorDeny, [
    "existing",
    "agent-dispatch-hub",
    "alias",
  ]);
  assert.deepEqual(rows[0].insert, [{ id: "custom", name: "custom-plugin" }]);
  assert.equal(
    mergeCompanionPatch(result.text, ["agent-dispatch-hub", "alias"]).changed,
    false,
  );
});
test("YAML dynamic deny expression is rejected without executing or serializing it", () => {
  assert.throws(
    () =>
      mergeCompanionPatch(
        "- id: codex-sync\n  config:\n    mcpMirrorDeny: !!js process.env.SECRET\n",
      ),
    { code: "DSH_PATCH_UNSUPPORTED" },
  );
});
test("removing a redundant bundle insertion retains disabled and other loader fields", () => {
  const merged = mergeCompanionPatch(
    "- insert:\n    - id: codex-dsh-bridge\n      name: codex-dsh-bridge-companion\n      disabled: true\n      config:\n        custom: retained\n",
  );
  const row = parseYaml(merged.text).find(
    (item) => item.id === "codex-dsh-bridge",
  );
  assert.equal(row.disabled, true);
  assert.equal(row.config.custom, "retained");
  assert.equal(mergeCompanionPatch(merged.text).changed, false);
});
test("companion install targets the selected home, retains backups and is content-idempotent while running", async (t) => {
  const options = await companionFixture(t);
  const oldPatch = await readFile(
    join(options.profileDir, "cordis.patch.yml"),
    "utf8",
  );
  await put(
    join(options.codexHome, "config.toml"),
    '[mcp_servers.custom_alias]\ncommand = "node"\nargs = ["/repo/bin/adh.mjs", "mcp"]\n',
  );
  const first = await installDshCompanions(options);
  assert.equal(first.changed, true);
  assert.equal(first.needsRestart, true);
  assert.equal(first.backups.length, 2);
  assert.equal(
    await readFile(
      first.backups.find((path) => path.includes("cordis.patch.yml.")),
      "utf8",
    ),
    oldPatch,
  );
  assert.equal(
    first.connectionFile,
    join(options.dshHome, ".codex-dsh-bridge", "connection.json"),
  );
  const rows = parseYaml(
    await readFile(join(options.profileDir, "cordis.patch.yml"), "utf8"),
  );
  assert.ok(
    rows
      .find((row) => row.id === "codex-sync")
      .config.mcpMirrorDeny.includes("custom_alias"),
  );
  const manifest = JSON.parse(
    await readFile(join(options.profileDir, "package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies.unrelated, "1.0.0");
  options.calls.length = 0;
  const second = await installDshCompanions({ ...options, running: true });
  assert.equal(second.changed, false);
  assert.equal(second.needsRestart, false);
  assert.equal(
    options.calls.filter((call) => call.command === options.dshCli).length,
    0,
  );
  assert.equal(
    (await readdir(join(options.dshHome, ".agent-dispatch-hub", "packages")))
      .length,
    2,
  );
});
test("running Desktop blocks changes after packing and before any profile write", async (t) => {
  const options = await companionFixture(t);
  const before = await readFile(
    join(options.profileDir, "cordis.patch.yml"),
    "utf8",
  );
  await assert.rejects(installDshCompanions({ ...options, running: true }), {
    code: "DSH_RUNNING",
  });
  assert.equal(
    await readFile(join(options.profileDir, "cordis.patch.yml"), "utf8"),
    before,
  );
  assert.equal(
    options.calls.filter((call) => call.command === options.dshCli).length,
    0,
  );
  assert.equal(
    (await readdir(options.profileDir)).some((name) => name.includes("backup")),
    false,
  );
});
test("dry-run prepares archives but does not install, back up or edit profile files", async (t) => {
  const options = await companionFixture(t);
  const result = await installDshCompanions({
    ...options,
    dryRun: true,
    running: true,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.backups, []);
  assert.equal(result.dryRun, true);
  assert.equal(options.calls.length, 2);
  assert.equal(
    (await readdir(options.profileDir)).some((name) => name.includes("backup")),
    false,
  );
});
test("setup normalizes only companion duplicate bundles and retains other metadata", async (t) => {
  const options = await companionFixture(t);
  await installDshCompanions(options);
  const path = join(options.profileDir, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.dsh.profile.bundles.push("dsh-codex-sync", "unrelated");
  manifest.custom = { keep: true };
  await writeFile(path, JSON.stringify(manifest));
  const result = await installDshCompanions(options);
  assert.equal(result.changed, true);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    after.dsh.profile.bundles.filter((name) => name === "dsh-codex-sync")
      .length,
    1,
  );
  assert.equal(
    after.dsh.profile.bundles.filter((name) => name === "unrelated").length,
    2,
  );
  assert.equal(after.custom.keep, true);
});
test("Codex fallback merges structured TOML, backs up bytes, and protects collisions", async (t) => {
  const root = await fixture(t);
  const codexHome = join(root, "codex");
  const configPath = join(codexHome, "config.toml");
  const original =
    '# original\nmodel = "custom-model"\n[mcp_servers.existing]\ncommand = "existing"\nargs = ["one"]\n[mcp_servers.existing.env]\nNONSECRET = "value"\n';
  await put(configPath, original);
  const options = {
    repoRoot: join(root, "repo with spaces"),
    home: join(root, "hub"),
    codexHome,
    codexCli: false,
  };
  const first = await registerCodexMcp(options);
  assert.equal(first.changed, true);
  assert.equal(await readFile(first.backupPath, "utf8"), original);
  const doc = parseToml(await readFile(configPath, "utf8"));
  assert.equal(doc.model, "custom-model");
  assert.equal(doc.mcp_servers.existing.env.NONSECRET, "value");
  assert.deepEqual(doc.mcp_servers["agent-dispatch-hub"].args, [
    join(options.repoRoot, "bin", "adh.mjs"),
    "mcp",
    "--home",
    options.home,
  ]);
  assert.equal((await registerCodexMcp(options)).changed, false);
  await assert.rejects(
    registerCodexMcp({ ...options, home: join(root, "other") }),
    { code: "MCP_NAME_CONFLICT" },
  );
});
test("Codex purpose-built CLI receives argv and CODEX_HOME, and registration is verified", async (t) => {
  const root = await fixture(t);
  const codexHome = join(root, "codex");
  const options = {
    repoRoot: join(root, "repo"),
    home: join(root, "hub"),
    codexHome,
    codexCli: "fixture-codex",
  };
  const calls = [];
  const runner = async (command, args, extra) => {
    calls.push({ command, args, extra });
    assert.equal(extra.env.CODEX_HOME, codexHome);
    await put(
      join(codexHome, "config.toml"),
      stringifyToml({
        mcp_servers: { [args[2]]: { command: args[4], args: args.slice(5) } },
      }),
    );
    return { exitCode: 0, stdout: "not returned to caller" };
  };
  const result = await registerCodexMcp({ ...options, runner });
  assert.equal(result.method, "codex-cli");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "mcp",
    "add",
    "agent-dispatch-hub",
    "--",
  ]);
});
test("invalid TOML fails without replacing or backing up config", async (t) => {
  const root = await fixture(t);
  const codexHome = join(root, "codex");
  const configPath = join(codexHome, "config.toml");
  await put(configPath, "broken = [");
  await assert.rejects(
    registerCodexMcp({
      repoRoot: root,
      home: join(root, "hub"),
      codexHome,
      codexCli: false,
    }),
    { code: "CODEX_CONFIG_INVALID" },
  );
  assert.equal(await readFile(configPath, "utf8"), "broken = [");
  assert.deepEqual(await readdir(codexHome), ["config.toml"]);
});
async function desktop(root, version) {
  const exe = join(root, "DeepSeek Harness.exe");
  const cli = join(root, "resources", "runtime", "cli", "bin", "dsh.cmd");
  await put(exe, "fixture");
  await put(cli, "fixture");
  const content = Buffer.from(
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version }),
  );
  const header = Buffer.from(
    JSON.stringify({
      files: { "package.json": { size: content.length, offset: "0" } },
    }),
  );
  const first = Buffer.alloc(16);
  first.writeUInt32LE(header.length + 8, 4);
  first.writeUInt32LE(header.length, 12);
  await put(
    join(root, "resources", "app.asar"),
    Buffer.concat([first, header, content]),
  );
  return { exe, cli };
}
test("native discovery validates archive metadata and uses user DSH_HOME without hardcoding a username", async (t) => {
  const root = await fixture(t);
  const app = await desktop(join(root, "native"), "0.2.1-rc.3");
  const result = await discoverLocal({
    platform: "win32",
    env: {},
    inventory: {
      userHome: join(root, "custom-home"),
      installs: [join(root, "stale")],
    },
    candidates: [app.exe],
  });
  assert.equal(result.dshCli, app.cli);
  assert.equal(result.dshHome, join(root, "custom-home"));
  assert.equal(
    result.profileDir,
    join(root, "custom-home", "profiles", "desktop"),
  );
  assert.equal(result.version, "0.2.1-rc.3");
});
test("discovery ambiguity needs an explicit installation and selected active native app wins", async (t) => {
  const root = await fixture(t);
  const one = await desktop(join(root, "one"), "0.2.1-rc.3");
  const two = await desktop(join(root, "two"), "0.2.1-rc.4");
  await assert.rejects(
    discoverLocal({
      platform: "win32",
      env: {},
      inventory: {},
      candidates: [one.exe, two.exe],
    }),
    { code: "DSH_AMBIGUOUS" },
  );
  const result = await discoverLocal({
    platform: "win32",
    env: {},
    inventory: { running: [two.exe] },
    candidates: [one.exe, two.exe],
  });
  assert.equal(result.appExe, two.exe);
  assert.equal(result.running, true);
});
test("other platforms require an explicit CLI and version compatibility fails closed", async (t) => {
  const root = await fixture(t);
  const cli = join(root, "dsh");
  await put(cli, "fixture");
  await assert.rejects(discoverLocal({ platform: "linux" }), {
    code: "DSH_CLI_REQUIRED",
  });
  const result = await discoverLocal({
    platform: "linux",
    dshCli: cli,
    dshHome: root,
    profile: "web",
    runner: async () => ({ stdout: "0.2.1-rc.3\n", exitCode: 0 }),
  });
  assert.equal(result.profile, "web");
  assert.equal(supportedDshVersion("0.2.1-rc.2"), false);
  assert.equal(supportedDshVersion("0.3.0"), false);
  assert.equal(supportedDshVersion("0.2.2"), true);
});
