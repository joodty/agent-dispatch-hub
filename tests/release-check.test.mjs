import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { runReleaseCheck, extractMarkdownLinks, REQUIRED_DEPENDENCY_SOURCES } from '../scripts/check-release.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));
const execFileAsync = promisify(execFile);

const FULL_SHA_A = `${'0'.repeat(39)}1`; // 40 位
const FULL_SHA_B = `${'a'.repeat(39)}b`; // 40 位

// ---------------------------------------------------------------- 夹具工具

async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'adh-release-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(baseline())) {
    await write(root, path, content);
  }
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(root, path), { recursive: true, force: true });
      continue;
    }
    await write(root, path, content);
  }
  return root;
}

async function write(root, path, content) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

const json = value => JSON.stringify(value, null, 2);

function baseline() {
  return {
    'package.json': {
      name: 'fixture-hub',
      version: '0.1.0',
      type: 'module',
      engines: { node: '>=22' },
      bin: { adh: 'bin/adh.mjs' },
      scripts: { test: 'node --test tests/*.test.mjs', check: 'node scripts/check-release.mjs' },
    },
    'package-lock.json': {
      name: 'fixture-hub',
      version: '0.1.0',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture-hub', version: '0.1.0', dependencies: {} } },
    },
    'dependencies.lock.json': {
      version: 1,
      sources: {
        bridge: { url: 'https://github.com/example-org/bridge.git', commit: FULL_SHA_A, upstream: 'https://github.com/upstream-bridge/bridge', license: 'NOASSERTION' },
        sync: { url: 'https://github.com/example-org/dsh-codex-sync.git', commit: FULL_SHA_B, upstream: 'https://github.com/upstream-sync/dsh-codex-sync', license: 'MIT' },
      },
    },
    'bin/adh.mjs': "console.log('fixture cli');\n",
    'scripts/check-release.mjs': '// 夹具内的占位入口，仅用于验证 scripts.check 指向的文件存在。\n',
    '.gitignore': 'node_modules/\ncoverage/\n',
    'README.md': [
      '# Fixture Hub',
      '',
      '交给 AI 安装：[AI 安装交接](README-AI.md)。',
      '连接说明：[连接与配置](docs/README-CONNECTIONS.md)。',
      '示例配置：[config.example.json](examples/config.example.json)。',
      '外部来源：[bridge](https://github.com/example-org/bridge)。',
      '章节锚点：[边界](#v010-的边界)。',
      '',
      '## v0.1.0 的边界',
      '',
      '只包含 fixture 适配器。',
      '',
    ].join('\n'),
    'README-AI.md': [
      '# AI 安装交接',
      '',
      '远程示例地址：`https://dsh.example.com`，不要当成真实环境。',
      '运行 `node bin/adh.mjs doctor`。',
      '',
    ].join('\n'),
    'docs/README-CONNECTIONS.md': [
      '# 连接与配置',
      '',
      '参考 [示例配置](../examples/config.example.json)，替换所有示例地址和路径后再使用。',
      'Windows 可使用 JSON 转义后的绝对路径，例如 `C:\\\\work\\\\demo`，具体格式须符合实际目标系统。',
      '',
      '```json',
      '{ "connectionFile": "/absolute/dsh-home/.codex-dsh-bridge/connection.json" }',
      '```',
      '',
      '```md',
      '代码块内的链接不做存在性检查：[不检查](docs/definitely-missing.md)。',
      '```',
      '',
    ].join('\n'),
    'examples/config.example.json': {
      version: 1,
      defaultTarget: 'office',
      targets: {
        office: { adapter: 'dsh', connection: { kind: 'local', connectionFile: '/absolute/dsh-home/.codex-dsh-bridge/connection.json' }, workspaces: { demo: '/absolute/local/project' } },
        home: { adapter: 'dsh', connection: { kind: 'remote', baseUrl: 'https://dsh.example.com', credentialFile: '/absolute/user-state/credentials/home.json' }, workspaces: { demo: '/absolute/path/on/remote/machine' } },
      },
    },
    'src/core/state.mjs': [
      "import { join } from 'node:path';",
      "import { homedir } from 'node:os';",
      "export function stateHome(value = process.env.ADH_HOME) { return value || join(homedir(), '.agent-dispatch-hub'); }",
      '',
    ].join('\n'),
    // 与真实仓库同形的测试 dummy：不得被扫描规则误报。
    'tests/pair.test.mjs': [
      "import { test } from 'node:test';",
      "test('pairing refuses a different host', async () => {",
      "  const config = { targets: { home: { connection: { kind: 'remote', baseUrl: 'https://home.example', credentialFile: join(home, 'credentials', 'home.json') } } } };",
      "  const launchUrl = 'https://other.example/?token=' + 'a'.repeat(43);",
      "  assert.equal(config.targets.home.connection.baseUrl, 'https://home.example');",
      "  await pairTarget(home, 'home', launchUrl, { fetchImpl: () => {} });",
      "});",
      '',
    ].join('\n'),
    'tests/mcp.test.mjs': "const hub = { dispatch: async () => { throw new HubError('backend-error', 'Backend failed.', { jobId: 'job-1', token: 'do-not-print' }); } };\n",
    'tests/hub.test.mjs': "await assert.rejects(hub.dispatch({ workspace: 'demo' }), error => !error.message.includes('secret'));\n",
  };
}

const errorCodes = report => new Set(report.issues.map(issue => issue.code));
const warnCodes = report => new Set(report.warnings.map(warning => warning.code));
const find = (report, code) => report.issues.filter(issue => issue.code === code);
const findWarn = (report, code) => report.warnings.filter(warning => warning.code === code);

// ---------------------------------------------------------------- 通过基线

test('valid fixture passes with zero errors and zero warnings', async t => {
  const root = await fixture(t);
  const report = await runReleaseCheck({ root });
  assert.deepEqual(report.issues, [], `不应有错误：${json(report.issues)}`);
  assert.deepEqual(report.warnings, [], `不应有告警：${json(report.warnings)}`);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(check => check.check), [
    'package-versions', 'dependency-lock', 'examples-json', 'markdown-links',
    'personal-paths', 'endpoints', 'secrets', 'sensitive-paths', 'workspace-hygiene',
  ]);
  assert.ok(report.checks.every(check => check.status === 'pass'));
  assert.ok(report.summary.filesScanned >= 10);
  assert.equal(report.summary.markdownFiles, 3);
  assert.equal(report.summary.exampleFiles, 1);
  assert.ok(report.note.includes('不声称穷尽秘密检测'));
});

test('checker source and this test file stay clean when scanned', async t => {
  const root = await fixture(t);
  await write(root, 'scripts/check-release.mjs', await readFile(SCRIPT, 'utf8'));
  await write(root, 'tests/release-check.test.mjs', await readFile(fileURLToPath(import.meta.url), 'utf8'));
  const report = await runReleaseCheck({ root });
  assert.deepEqual(report.issues, [], `两个文件自身不应命中规则：${json(report.issues)}`);
  assert.deepEqual(report.warnings, [], `两个文件自身不应产生告警：${json(report.warnings)}`);
});

test('required dependency sources are bridge and sync', () => {
  assert.deepEqual([...REQUIRED_DEPENDENCY_SOURCES], ['bridge', 'sync']);
});

// ---------------------------------------------------------------- 坏链接

test('reports a missing local markdown link and ignores anchors, external links and fenced code', async t => {
  const root = await fixture(t, {
    'README.md': [
      '# Fixture Hub',
      '',
      '存在的：[连接](docs/README-CONNECTIONS.md)。',
      '缺失的：[故障排查](docs/README-TROUBLESHOOTING.md)。',
      '目录锚点：[边界](#v010-的边界)。',
      '外链：[上游](https://github.com/example-org/bridge)。',
      '占位：[模板](docs/<名称>.md)。',
      '绝对路径：[本机](/etc/hosts)。',
      '',
    ].join('\n'),
  });
  const report = await runReleaseCheck({ root });
  const missing = find(report, 'markdown-link-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].file, 'README.md');
  assert.equal(missing[0].line, 4);
  assert.equal(missing[0].target, 'docs/README-TROUBLESHOOTING.md');
  assert.ok(find(report, 'markdown-link-absolute-path').length === 1);
  // 基线里的代码块内坏链接没有被报告。
  assert.ok(!report.issues.some(issue => issue.file === 'docs/README-CONNECTIONS.md'));
});

test('extractMarkdownLinks skips fenced code blocks and inline code', () => {
  const links = extractMarkdownLinks(['[ok](a.md)', '```', '[no](b.md)', '```', '行内 `[nope](c.md)` 不算。', '[angle](<d e.md>)'].join('\n'));
  assert.deepEqual(links.map(link => link.target), ['a.md', 'd e.md']);
});

test('links pointing outside the repository are warnings, not errors', async t => {
  const root = await fixture(t);
  const name = `${root.split(/[\\/]/).pop()}-outside.md`;
  const outside = join(root, '..', name);
  await writeFile(outside, '# outside\n', 'utf8');
  t.after(() => rm(outside, { force: true }));
  await write(root, 'docs/deep/OUTSIDE.md', `上层链接：[外部](../../../${name})。\n`);
  const report = await runReleaseCheck({ root });
  assert.equal(report.ok, true, json(report.issues));
  assert.equal(findWarn(report, 'markdown-link-outside-root').length, 1);
});

// ---------------------------------------------------------------- 依赖锁

test('missing dependency lock is reported as an error with a clear code', async t => {
  const root = await fixture(t, { 'dependencies.lock.json': null });
  const report = await runReleaseCheck({ root });
  assert.equal(report.ok, false);
  assert.equal(find(report, 'dependency-lock-missing').length, 1);
  assert.ok(find(report, 'dependency-lock-missing')[0].message.includes('bootstrap'));
});

test('rejects short SHA, uppercase SHA, SSH url, non-GitHub host and missing sync', async t => {
  const lock = sources => json({ version: 1, sources });
  const cases = [
    { name: 'short SHA', sources: { bridge: { url: 'https://github.com/example-org/bridge.git', commit: 'b2ea79e' }, sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B } }, code: 'dependency-commit-not-full-sha', source: 'bridge' },
    { name: 'uppercase SHA', sources: { bridge: { url: 'https://github.com/example-org/bridge.git', commit: FULL_SHA_B.toUpperCase() }, sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B } }, code: 'dependency-commit-not-full-sha', source: 'bridge' },
    { name: 'missing commit', sources: { bridge: { url: 'https://github.com/example-org/bridge.git' }, sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B } }, code: 'dependency-commit-missing', source: 'bridge' },
    { name: 'SSH url', sources: { bridge: { url: 'git@github.com:example-org/bridge.git', commit: FULL_SHA_A }, sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B } }, code: 'dependency-url-not-github-https', source: 'bridge' },
    { name: 'git protocol url', sources: { bridge: { url: 'git://github.com/example-org/bridge.git', commit: FULL_SHA_A }, sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B } }, code: 'dependency-url-not-github-https', source: 'bridge' },
    { name: 'non-GitHub host', sources: { bridge: { url: 'https://git.internal.example-org.dev/bridge.git', commit: FULL_SHA_A }, sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B } }, code: 'dependency-url-not-github-https', source: 'bridge' }, // release-check:ignore 夹具需要非 GitHub 主机
    { name: 'missing sync source', sources: { bridge: { url: 'https://github.com/example-org/bridge.git', commit: FULL_SHA_A } }, code: 'dependency-lock-missing-source', source: 'sync' },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async inner => {
      const root = await fixture(inner, { 'dependencies.lock.json': lock(testCase.sources) });
      const report = await runReleaseCheck({ root });
      assert.equal(report.ok, false);
      const hits = find(report, testCase.code);
      assert.ok(hits.length >= 1, `期望命中 ${testCase.code}`);
      assert.equal(hits[0].source, testCase.source);
      assert.equal(hits[0].file, 'dependencies.lock.json');
      // 固定提交号与 URL 的取值不进入报告。
      assert.ok(!/[0-9a-f]{40}/u.test(json(report).toLowerCase()), `报告不应包含完整提交号取值：${json(report)}`);
    });
  }
});

test('unrecorded upstream or license is a warning only', async t => {
  const root = await fixture(t, {
    'dependencies.lock.json': {
      version: 1,
      sources: {
        bridge: { url: 'https://github.com/example-org/bridge.git', commit: FULL_SHA_A },
        sync: { url: 'https://github.com/example-org/sync.git', commit: FULL_SHA_B },
      },
    },
  });
  const report = await runReleaseCheck({ root });
  assert.equal(report.ok, true);
  assert.equal(findWarn(report, 'dependency-license-unrecorded').length, 2);
  assert.deepEqual(findWarn(report, 'dependency-license-unrecorded').map(warning => warning.source), ['bridge', 'sync']);
});

// ---------------------------------------------------------------- 版本一致性

test('root version mismatch between package.json and the npm lock fails', async t => {
  const root = await fixture(t, { 'package-lock.json': { name: 'fixture-hub', version: '0.0.9', lockfileVersion: 3, packages: { '': { name: 'fixture-hub', version: '0.0.9' } } } });
  const report = await runReleaseCheck({ root });
  assert.equal(report.ok, false);
  assert.equal(find(report, 'version-mismatch').length, 2);
  assert.ok(find(report, 'version-mismatch')[0].message.includes('0.1.0'));
});

test('missing or unparseable lock file and dangling entry scripts fail', async t => {
  const missing = await fixture(t, { 'package-lock.json': null });
  assert.ok(errorCodes(await runReleaseCheck({ root: missing })).has('lock-file-missing'));

  const dangling = await fixture(t, { 'package.json': json({ name: 'fixture-hub', version: '0.1.0', engines: { node: '>=22' }, scripts: { check: 'node scripts/definitely-missing.mjs' } }) });
  const report = await runReleaseCheck({ root: dangling });
  const hits = find(report, 'entry-script-missing');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'package.json');
  assert.ok(!json(report).includes('definitely-missing'), '不应回显脚本名之外的内容');

  const broken = await fixture(t, { 'package-lock.json': '{ "version": "0.1.0",, }' });
  const brokenReport = await runReleaseCheck({ root: broken });
  assert.equal(find(brokenReport, 'lock-file-unparseable').length, 1);
});

test('engines below Node 22 is a warning and package name mismatch is an error', async t => {
  const root = await fixture(t, {
    'package.json': json({ name: 'fixture-hub', version: '0.1.0', engines: { node: '>=18' }, scripts: { check: 'node scripts/check-release.mjs' } }),
    'package-lock.json': json({ name: 'other-hub', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'other-hub', version: '0.1.0' } } }),
  });
  const report = await runReleaseCheck({ root });
  assert.ok(errorCodes(report).has('package-name-mismatch'));
  assert.ok(warnCodes(report).has('engines-node-unexpected'));
});

// ---------------------------------------------------------------- examples JSON

test('unparseable example JSON is reported without echoing the input fragment', async t => {
  const secretish = '{ "token": "SUP3R-SECRET-VALUE-ABCDEFGHIJKL",, }'; // release-check:ignore 夹具需要 token 形态
  const root = await fixture(t, { 'examples/config.example.json': secretish });
  const report = await runReleaseCheck({ root });
  const hits = find(report, 'example-json-unparseable');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'examples/config.example.json');
  assert.ok(!json(report).includes('SUP3R'), '报告不得包含 JSON 原文片段');
});

test('empty example JSON and a missing examples directory are handled', async t => {
  const empty = await fixture(t, { 'examples/blank.json': '   \n' });
  assert.ok(errorCodes(await runReleaseCheck({ root: empty })).has('example-json-empty'));
  const linkless = {
    'README.md': '# Fixture Hub\n\n本仓库不带示例目录。\n',
    'docs/README-CONNECTIONS.md': '# 连接与配置\n\n配置见 hub 状态目录。\n',
  };
  const none = await fixture(t, { ...linkless, examples: null });
  const report = await runReleaseCheck({ root: none });
  assert.equal(report.ok, true, json(report.issues));
  assert.equal(findWarn(report, 'examples-directory-missing').length, 1);
});

// ---------------------------------------------------------------- 本机路径

test('flags personal absolute paths in source but not fictional documentation examples', async t => {
  const windowsPath = 'C:\\Users\\dev\\project\\.dsh'; // release-check:ignore 夹具需要真实形态
  const drivePath = 'D:/service/fixture-repo'; // release-check:ignore 夹具需要真实形态
  const posixPath = '/home/dev/workspace/demo'; // release-check:ignore 夹具需要真实形态
  const uncPath = '\\\\fileserver\\share\\adh'; // release-check:ignore 夹具需要真实形态
  const root = await fixture(t, {
    'src/core/leak.mjs': [
      `const stateHome = ${JSON.stringify(windowsPath)};`,
      `const repo = ${JSON.stringify(drivePath)};`,
      `const workspace = ${JSON.stringify(posixPath)};`,
      `const remote = ${JSON.stringify(uncPath)};`,
      '',
    ].join('\n'),
  });
  const report = await runReleaseCheck({ root });
  const codes = errorCodes(report);
  assert.ok(codes.has('personal-path-windows-user'), json([...codes]));
  assert.ok(codes.has('local-drive-path-in-code'));
  assert.ok(codes.has('personal-path-posix-user'));
  assert.ok(codes.has('unc-path-present'));
  assert.ok(find(report, 'personal-path-windows-user')[0].file === 'src/core/leak.mjs');
  assert.ok(find(report, 'personal-path-windows-user')[0].line === 1);
  // 命中只报告文件与行号，路径值本身不进入报告。
  assert.ok(!json(report).includes('dev'));
  assert.ok(!json(report).includes('fileserver'));
});

test('drive paths in Markdown are warnings, placeholder paths stay silent', async t => {
  const root = await fixture(t, {
    'docs/PATHS.md': [
      '文档示例：`C:\\\\work\\\\demo` 与 `D:\\\\service\\\\fixture-repo`。', // release-check:ignore 夹具需要真实形态
      '状态目录：`/absolute/dsh-home/.codex-dsh-bridge/connection.json`。',
      '虚构工作区别名：`/absolute/local/project`。',
      '',
    ].join('\n'),
  });
  const report = await runReleaseCheck({ root });
  assert.equal(report.ok, true, `文档中的盘符只应告警：${json(report.issues)}`);
  assert.equal(findWarn(report, 'local-drive-path-in-docs').length, 1, '占位 work 路径不应命中，真实本机路径应命中一次');
});

test('a line marked release-check:ignore is skipped', async t => {
  const root = await fixture(t, { 'src/annotated.mjs': "const home = 'C:\\Users\\dev\\x'; // release-check:ignore 文档示例需要\n" });
  const report = await runReleaseCheck({ root });
  assert.deepEqual(report.issues, []);
});

// ---------------------------------------------------------------- 端点与凭证

test('flags a real-looking DSH endpoint without echoing the host', async t => {
  const host = 'https://dsh-hq.corp.internal:8443/'; // release-check:ignore 夹具需要真实形态
  const root = await fixture(t, {
    'src/adapters/private.mjs': `const baseUrl = ${JSON.stringify(host)};\n`,
    'docs/DEPLOY.md': `访问 ${host} 完成验收。\n`,
  });
  const report = await runReleaseCheck({ root });
  assert.ok(errorCodes(report).has('private-endpoint-host'));
  assert.ok(errorCodes(report).has('insecure-http-endpoint') === false);
  assert.ok(!json(report).includes('dsh-hq'), '报告不得包含真实主机名');
  assert.ok(find(report, 'private-endpoint-host').every(issue => issue.file && typeof issue.line === 'number'));

  const http = await fixture(t, { 'src/adapters/plain.mjs': "const url = 'http://dsh-office.corp.lan/status';\n" }); // release-check:ignore 夹具需要真实形态
  const httpReport = await runReleaseCheck({ root: http });
  assert.ok(errorCodes(httpReport).has('insecure-http-endpoint'));

  const ip = await fixture(t, { 'src/adapters/ip.mjs': "const url = 'https://10.20.30.40:9100/api';\n" }); // release-check:ignore 夹具需要真实形态
  const ipReport = await runReleaseCheck({ root: ip });
  assert.ok(errorCodes(ipReport).has('endpoint-ipv4-literal'), json(ipReport.issues));

  const loopback = await fixture(t, { 'src/adapters/loop.mjs': "const url = 'http://127.0.0.1:57382/api';\n" }); // release-check:ignore 夹具需要真实形态
  const loopReport = await runReleaseCheck({ root: loopback });
  assert.equal(loopReport.ok, true, `回环端点只告警：${json(loopReport.issues)}`);
  assert.equal(errorCodes(loopReport).has('endpoint-ipv4-literal'), false, '本机回环地址不算真实 DSH 端点');
  assert.equal(errorCodes(loopReport).has('insecure-http-endpoint'), false, '回环 http 属于本机调试约定，不报错误');
  assert.equal(findWarn(loopReport, 'loopback-endpoint-with-port').length, 1);
});

test('flags credential-shaped values and never prints them', async t => {
  const token = `sk-${'A'.repeat(30)}`;
  const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEA', '-----END OPENSSH PRIVATE KEY-----'].join('\n'); // release-check:ignore 夹具需要私钥块形态
  const root = await fixture(t, {
    'src/core/creds.mjs': [
      `const launchToken = ${JSON.stringify(token)};`,
      `const authorization = ${JSON.stringify(`Bearer ${'q'.repeat(24)}`)};`,
      "const cookie = 'session=abc123def456ghi789jkl012';", // release-check:ignore 夹具需要 cookie 形态
      `const query = ${JSON.stringify('https://dsh.example.com/?token=' + 'R'.repeat(40))};`,
      '',
    ].join('\n'),
    'deploy/legacy-note.txt': `${key}\n`,
    'deploy/id_ed25519': key,
  });
  const report = await runReleaseCheck({ root });
  const codes = errorCodes(report);
  assert.ok(codes.has('known-token-format'), json([...codes]));
  assert.ok(codes.has('authorization-header-literal'));
  assert.ok(codes.has('credential-assignment-literal'));
  assert.ok(codes.has('url-query-secret'));
  assert.ok(codes.has('private-key-block'));
  assert.ok(codes.has('sensitive-file-present'));
  assert.ok(!json(report).includes('A'.repeat(10)), '报告不得包含 token 取值');
  assert.ok(!json(report).includes('b3BlbnNzaC1rZXk'), '报告不得包含私钥内容');
  assert.equal(find(report, 'sensitive-file-present')[0].file, 'deploy/id_ed25519');
});

test('user state directories are reported but never read', async t => {
  const root = await fixture(t, { 'credentials/home.json': json({ version: 1, origin: 'https://dsh.example.com', cookie: `session=${'Z'.repeat(32)}` }) });
  const report = await runReleaseCheck({ root });
  assert.ok(errorCodes(report).has('sensitive-path-present'));
  assert.ok(!json(report).includes('Z'.repeat(8)), '凭据内容不得进入报告');
  assert.equal(find(report, 'sensitive-path-present')[0].file, 'credentials');
});

test('node_modules, .git and lock files are excluded from the text scan', async t => {
  const windowsPath = 'C:\\Users\\dev\\secret-machine'; // release-check:ignore 夹具需要真实形态
  const root = await fixture(t, {
    'node_modules/pkg/index.mjs': `const home = ${JSON.stringify(windowsPath)};\n`,
    '.git/config': `[remote "origin"]\n\turl = ${JSON.stringify('https://dsh-hq.corp.internal:8443/')}\n`, // release-check:ignore 夹具需要真实形态
    'package-lock.json': json({ name: 'fixture-hub', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'fixture-hub', version: '0.1.0', dependencies: {} }, 'node_modules/express': { resolved: 'https://registry.npmjs.org/express/-/express-5.3.0.tgz' } } }),
  });
  const report = await runReleaseCheck({ root });
  assert.deepEqual(report.issues, [], `排除目录不应被扫描：${json(report.issues)}`);
  assert.ok(!report.summary.filesScanned.toString().includes('node_modules'));
});

test('root that does not exist is an error without throwing', async t => {
  const missing = join(await mkdtemp(join(tmpdir(), 'adh-missing-')), 'nope');
  const report = await runReleaseCheck({ root: missing });
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map(issue => issue.code), ['root-unavailable']);
});

// ---------------------------------------------------------------- CLI 合同

async function runCli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { exitCode: 0, stdout };
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return { skipped: true };
    return { exitCode: typeof error?.code === 'number' ? error.code : 1, stdout: error?.stdout ?? '' };
  }
}

test('CLI exits 0 with parseable JSON when clean and 1 when failing', async t => {
  const good = await fixture(t);
  const bad = await fixture(t, { 'README.md': '[缺失](docs/nope.md)\n' });

  const passed = await runCli(['--root', good]);
  if (passed.skipped) { t.skip('当前沙箱不允许 spawn 子进程'); return; }
  assert.equal(passed.exitCode, 0);
  assert.equal(JSON.parse(passed.stdout).ok, true);

  const failed = await runCli(['--root', bad]);
  assert.equal(failed.exitCode, 1);
  assert.equal(JSON.parse(failed.stdout).ok, false);
  assert.equal(JSON.parse(failed.stdout).issues[0].code, 'markdown-link-missing');

  const help = await runCli(['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /check-release\.mjs/);

  const invalid = await runCli(['--nope=SUP3R-ARG-VALUE']);
  assert.equal(invalid.exitCode, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'invalid-arguments');
  assert.ok(!invalid.stdout.includes('SUP3R'), '无效参数不回显调用值');
});
