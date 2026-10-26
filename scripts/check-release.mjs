#!/usr/bin/env node
// Agent Dispatch Hub 发布前检查脚本（第一版，零第三方依赖，Node >= 22）。
//
// 用法：
//   node scripts/check-release.mjs                 // 默认检查脚本所在仓库根目录
//   node scripts/check-release.mjs --root <dir>    // 检查指定夹具目录（测试用）
//   npm run check                                  // package.json 已挂接
//
// 检查项：
//   1. package.json 与 npm 锁文件根版本一致，engines 与 scripts.check/bin 入口自洽；
//   2. dependencies.lock.json 存在，每个来源固定 GitHub HTTPS URL 与完整 40 位提交号，
//      且必须包含 bridge 与 sync；
//   3. examples 目录下所有 JSON 可解析；
//   4. 所有 Markdown 的本地相对链接目标存在（忽略 http(s)/mailto 等外链与纯锚点）；
//   5. 源码文本扫描，防止提交本机个人绝对路径、真实 DSH 端点地址与凭证字面量。
//
// 约定：
//   - 疑似秘密只报告文件、行号与规则编号，绝不输出匹配内容；
//   - 跳过 node_modules、.git 与用户状态目录，且不读取其中的文件；
//   - 行内含 `release-check:ignore` 时跳过该行，供规则定义、测试夹具与文档示例使用；
//   - 这是模式匹配，不声称穷尽秘密检测，也不替代人工复核。
//
// 退出码：0 = 通过（允许告警）；1 = 存在错误或调用方式不正确。

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

export const SCRIPT_FILE = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- 配置常量

/** 完全不进入的通用目录。 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'coverage', 'dist', 'build', 'out',
  '.cache', '.turbo', '.next', '.pnpm-store', '__pycache__',
]);

/** 用户状态目录：不读取内容；出现在仓库内时单独报错。 */
const USER_STATE_DIRS = new Set([
  '.agent-dispatch-hub', '.dsh', 'credentials', '.codex-dsh-bridge', 'launch-url',
]);

/** 敏感文件或目录名（只报告名字与规则，不读取内容）。 */
const SENSITIVE_NAME_PATTERNS = [
  /^connection\.json$/i,
  /^\.env$/i,
  /\.(pem|key|p12|pfx|jks|kdbx)$/i,
  /^id_(rsa|ed25519|ecdsa)$/i,
  /(^|[-._])launch[-_]?url/i,
  /\.token$/i,
  /(^|[-._])(cookie|secret)s?[._-]\w+$/i,
];

/** 参与文本扫描的扩展名。 */
const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.jsx', '.ts', '.mts', '.json', '.md', '.markdown',
  '.yml', '.yaml', '.toml', '.ini', '.txt', '.sh', '.bash', '.zsh', '.ps1',
  '.cmd', '.bat', '.example', '.sample', '.conf',
]);
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', '.gitignore', '.editorconfig', '.npmrc', '.env']);

/** 生成物：内容不参与本机路径/端点/凭证扫描（版本一致性另行校验）。 */
const GENERATED_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_REPORTED_PER_CODE = 40;

/** 依赖锁必须存在的来源名。 */
export const REQUIRED_DEPENDENCY_SOURCES = Object.freeze(['bridge', 'sync']);

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 允许出现在仓库文本中的公开或占位主机；其余外部主机视为私人端点。 */
const ALLOWED_HOSTS = new Set([
  'github.com', 'npmjs.org', 'npmjs.com', 'nodejs.org', 'example.com', 'example.org',
  'example.net', 'example.edu', 'example.io', 'test.com', 'localhost', '127.0.0.1',
  '::1', '0.0.0.0', 'w3.org', 'spdx.org', 'opensource.org', 'choosealicense.com',
  'fsf.org', 'gnu.org', 'unicode.org',
]);
const ALLOWED_HOST_SUFFIXES = ['.github.com', '.githubusercontent.com', '.npmjs.org', '.npmjs.com', '.nodejs.org', '.example.com', '.example.org', '.example.net', '.w3.org', '.gnu.org'];

/** 文档中的虚构路径首段，不视为本机布局。 */
const PLACEHOLDER_FIRST_SEGMENTS = new Set([
  'work', 'works', 'demo', 'project', 'projects', 'code', 'src', 'dev', 'app', 'apps',
  'abs', 'absolute', 'path', 'paths', 'tmp', 'temp', 'data', 'media', 'target', 'sample',
]);

/** 明显是测试假数据或占位物的行内标记，避免 dummy 值误报。 */
const DUMMY_MARKERS = [
  'release-check:ignore', 'example', 'placeholder', 'dummy', 'sample', 'changeme', 'change-me',
  'do-not-print', 'not-a-real', 'redacted', 'masked', 'secret-token-value', 'nonsecret',
  'repeat(', 'process.env', 'os.environ', 'xxx', '{{', '${', 'invalid', 'fake', 'mock', 'todo',
];

// ---------------------------------------------------------------- 规则定义

const PERSONAL_PATH_RULES = [
  { code: 'personal-path-windows-user', bucket: 'personal-paths', severity: 'error', re: /(?<![\w:./-])[A-Za-z]:[\\/]{1,2}(?:Users|Documents and Settings|home|AppData|OneDrive|Desktop|Downloads)(?:[\\/]|$)/iu },
  { code: 'personal-path-posix-user', bucket: 'personal-paths', severity: 'error', re: /(?:^|[\s'"`(=,:])\/(?:Users|home)\/[\w.+-]{1,64}\//u },
  { code: 'unc-path-present', bucket: 'personal-paths', severity: 'error', re: /(?<!\\)\\{4}[\w.-]{2,64}\\{2}(?!\\)/u },
  // 代码/配置里的任意盘符绝对路径＝本机布局泄漏；Markdown 里同样的写法只告警。
  { code: 'local-drive-path-in-code', bucket: 'personal-paths', severity: 'error', nonMarkdown: true, placeholderAware: true, re: /(?<![\w:./-])[A-Za-z]:[\\/]{1,2}[\w. +-]{2,64}(?![\w])/u },
  { code: 'local-drive-path-in-docs', bucket: 'personal-paths', severity: 'warn', markdownOnly: true, placeholderAware: true, re: /(?<![\w:./-])[A-Za-z]:[\\/]{1,2}[\w. +-]{2,64}(?![\w])/u },
];

const ENDPOINT_RULES = [
  { code: 'url-with-credentials', bucket: 'endpoints', severity: 'error', re: /\b(?:https?|wss?|ftp):\/\/[^\s/:@]+:[^\s/@]+@/iu },
  { code: 'url-query-secret', bucket: 'endpoints', severity: 'error', re: /[?&](?:token|access_token|refresh_token|api_key|apikey|password|passwd|signature|auth)=\S{16,}/i },
  { code: 'endpoint-ipv4-literal', bucket: 'endpoints', severity: 'error', re: /\b(?:https?|wss?|ftp):\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/iu },
  { code: 'loopback-endpoint-with-port', bucket: 'endpoints', severity: 'warn', re: /\b(?:127\.0\.0\.1|\[::1\]|localhost):\d{2,5}\b/iu },
];

const SECRET_RULES = [
  { code: 'private-key-block', bucket: 'secrets', severity: 'error', re: /-{5}BEGIN [A-Z ]{2,40}PRIVATE KEY-{5}/u },
  { code: 'known-token-format', bucket: 'secrets', severity: 'error', re: /\b(?:gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[abprs]-[0-9A-Za-z-]{10,}|npm_[0-9A-Za-z]{30,}|glpat-[0-9A-Za-z_-]{20,}|ya29[.][0-9A-Za-z_-]{20,}|AIza[0-9A-Za-z_-]{30,}|sk-(?:ant-|proj-)?[0-9A-Za-z]{24,})/u },
  { code: 'jwt-like-token', bucket: 'secrets', severity: 'error', re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/u },
  { code: 'authorization-header-literal', bucket: 'secrets', severity: 'error', re: /\bAuthorization["']?\s*[:=]\s*["']?(?:Basic|Bearer)\s+[\w+/=.:-]{20,}/iu },
  { code: 'cookie-header-literal', bucket: 'secrets', severity: 'error', re: /\bSet-Cookie["']?\s*[:=]\s*["'][^"'\s]{20,};/iu },
  { code: 'credential-assignment-literal', bucket: 'secrets', severity: 'error', re: /(?:^|[^\w.-])(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?secret|cookie|token|authorization|bearer)\b["']?\s*[:=]\s*["'][^\s"']{12,}["']/iu },
];

const ALL_RULES = [...PERSONAL_PATH_RULES, ...ENDPOINT_RULES, ...SECRET_RULES];
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>()\[\]{}|]+/giu;

// ---------------------------------------------------------------- 结果收集

function createContext(root) {
  return {
    root,
    issues: [],
    warnings: [],
    seenCodes: new Map(),
    seenKeys: new Set(),
    stats: { filesScanned: 0, markdownFiles: 0, exampleFiles: 0, skippedLarge: 0 },
  };
}

function push(ctx, entry, bucket) {
  const key = `${entry.code}\u0000${entry.file ?? ''}\u0000${entry.line ?? ''}`;
  if (ctx.seenKeys.has(key)) return;
  if ((ctx.seenCodes.get(entry.code) ?? 0) >= MAX_REPORTED_PER_CODE) {
    ctx.seenCodes.set(`${entry.code}\u0000truncated`, true);
    return;
  }
  ctx.seenKeys.add(key);
  ctx.seenCodes.set(entry.code, (ctx.seenCodes.get(entry.code) ?? 0) + 1);
  (bucket === 'error' ? ctx.issues : ctx.warnings).push(entry);
}

function addError(ctx, check, code, message, extra = {}) {
  push(ctx, { check, code, message, ...compact(extra) }, 'error');
}

function addWarning(ctx, check, code, message, extra = {}) {
  push(ctx, { check, code, message, ...compact(extra) }, 'warn');
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ''));
}

function rel(ctx, path) {
  const value = relative(ctx.root, path);
  return value ? value.split(sep).join('/') : '.';
}

function looksDummy(line) {
  return DUMMY_MARKERS.some(marker => line.toLowerCase().includes(marker));
}

async function readText(ctx, path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.includes('\0') ? undefined : text; // 二进制内容跳过
  } catch (error) {
    addError(ctx, 'workspace-hygiene', 'file-unreadable', '文件无法读取，未读取内容。', { file: rel(ctx, path), reason: error.code ?? 'read-error' });
    return undefined;
  }
}

// ---------------------------------------------------------------- 目录遍历

function sensitiveName(name) {
  return SENSITIVE_NAME_PATTERNS.some(pattern => pattern.test(name));
}

function isTextCandidate(name) {
  if (GENERATED_FILES.has(name)) return false;
  const lower = name.toLowerCase();
  if (TEXT_BASENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  return dot > 0 && TEXT_EXTENSIONS.has(lower.slice(dot));
}

async function walk(ctx, directory, collector, { reportSensitive = false } = {}) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') addError(ctx, 'workspace-hygiene', 'directory-unreadable', '目录无法枚举。', { reason: error.code ?? 'read-error' });
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (USER_STATE_DIRS.has(entry.name) || (reportSensitive && sensitiveName(entry.name))) {
        if (reportSensitive) addError(ctx, 'sensitive-paths', 'sensitive-path-present', '仓库内出现用户状态或凭据目录，未读取其中内容。', { file: rel(ctx, path) });
        continue;
      }
      await walk(ctx, path, collector, { reportSensitive });
      continue;
    }
    if (!entry.isFile()) continue;
    if (USER_STATE_DIRS.has(entry.name) || (reportSensitive && sensitiveName(entry.name))) {
      if (reportSensitive) addError(ctx, 'sensitive-paths', 'sensitive-file-present', '仓库内出现疑似凭据文件，未读取其中内容。', { file: rel(ctx, path) });
      continue;
    }
    await collector(path, entry.name);
  }
}

// ---------------------------------------------------------------- 通用读取

async function existsAnyKind(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function existsFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function readJsonFile(ctx, path, check, missingCode, problemCode, message) {
  if (!(await existsAnyKind(path))) {
    addError(ctx, check, missingCode, message.missing, { file: rel(ctx, path) });
    return undefined;
  }
  const text = await readText(ctx, path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    // 不拼接 error.message：解析错误会带出输入片段，可能包含秘密。只报告位置数字。
    addError(ctx, check, problemCode, message.unparseable, { file: rel(ctx, path), name: error?.name ?? 'SyntaxError', ...jsonPosition(error) });
    return undefined;
  }
}

function jsonPosition(error) {
  // error.message 会带出输入片段，可能含秘密；只从中原样抽取纯数字位置信息。
  const message = String(error?.message ?? '');
  const number = value => (value === undefined ? undefined : Number(value));
  const position = number(/position (\d+)/u.exec(message)?.[1]);
  const line = number(/line (\d+)/u.exec(message)?.[1] ?? error?.lineNumber);
  const column = number(/column (\d+)/u.exec(message)?.[1] ?? error?.columnNumber);
  return compact({ line, column, offset: position });
}

// ---------------------------------------------------------------- 检查 1：版本与入口

async function checkPackageVersions(ctx) {
  const packageFile = join(ctx.root, 'package.json');
  const pkg = await readJsonFile(ctx, packageFile, 'package-versions',
    'package-json-missing', 'package-json-unparseable',
    { missing: 'package.json 缺失。', unparseable: 'package.json 不是有效 JSON（仅报告位置，不回显内容片段）。' });
  if (!pkg) return;
  if (typeof pkg.version !== 'string' || !pkg.version) {
    addError(ctx, 'package-versions', 'package-version-missing', 'package.json 缺少 version 字段。');
  }
  const engines = typeof pkg.engines?.node === 'string' ? pkg.engines.node : undefined;
  if (!engines) addWarning(ctx, 'package-versions', 'engines-node-unspecified', 'package.json 未声明 engines.node。');
  else if (!/(^|[^\d])(2[2-9]|[3-9]\d)(\D|$)/.test(engines)) addWarning(ctx, 'package-versions', 'engines-node-unexpected', 'engines.node 未覆盖 Node 22 及以上。');

  const packageJsonPath = rel(ctx, packageFile);
  for (const [label, value] of [['scripts.check', pkg.scripts?.check], ['bin', typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.adh]]) {
    if (typeof value !== 'string') continue;
    const target = label === 'scripts.check' ? nodeScriptTarget(value) : value;
    if (!target) continue;
    const absolute = resolve(ctx.root, target);
    const inside = absolute === ctx.root || absolute.startsWith(ctx.root + sep);
    if (!inside) {
      addWarning(ctx, 'package-versions', 'entry-path-outside-root', `${label} 指向仓库之外，发布包内不存在该文件。`);
      continue;
    }
    if (!(await existsFile(absolute))) addError(ctx, 'package-versions', 'entry-script-missing', `${label} 指向的脚本在仓库内不存在。`, { file: packageJsonPath });
  }

  const lock = await readJsonFile(ctx, join(ctx.root, 'package-lock.json'), 'package-versions',
    'lock-file-missing', 'lock-file-unparseable',
    { missing: 'npm 锁文件 package-lock.json 缺失：发布需要可复现安装。', unparseable: 'package-lock.json 不是有效 JSON（仅报告位置，不回显内容片段）。' });
  if (!lock) return;
  const roots = [['version', lock.version], ['packages[""].version', lock.packages?.['']?.version]].filter(([, value]) => typeof value === 'string');
  if (!roots.length) {
    addError(ctx, 'package-versions', 'lock-version-missing', 'package-lock.json 未记录根版本。');
    return;
  }
  for (const [where, value] of roots) {
    if (pkg.version !== value) addError(ctx, 'package-versions', 'version-mismatch', `根版本不一致：package.json=${pkg.version ?? 'missing'}，package-lock.json(${where})=${value}。`);
  }
  if (typeof lock.name === 'string' && typeof pkg.name === 'string' && lock.name !== pkg.name) {
    addError(ctx, 'package-versions', 'package-name-mismatch', `包名不一致：package.json=${pkg.name}，package-lock.json=${lock.name}。`);
  }
}

function nodeScriptTarget(script) {
  const match = /(?:^|[\s&;|(])node\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|)]+))/.exec(script);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

// ---------------------------------------------------------------- 检查 2：依赖锁

async function checkDependencyLock(ctx) {
  const lock = await readJsonFile(ctx, join(ctx.root, 'dependencies.lock.json'), 'dependency-lock',
    'dependency-lock-missing', 'dependency-lock-unparseable',
    { missing: 'dependencies.lock.json 缺失：无法固定外部来源与提交号，bootstrap/doctor 会失败。', unparseable: 'dependencies.lock.json 不是有效 JSON（仅报告位置，不回显内容片段）。' });
  if (!lock) return;
  const sources = lock.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    addError(ctx, 'dependency-lock', 'dependency-lock-sources-missing', 'dependencies.lock.json 缺少 sources 对象。');
    return;
  }
  const names = Object.keys(sources);
  if (!names.length) addError(ctx, 'dependency-lock', 'dependency-lock-empty', 'dependencies.lock.json 的 sources 为空。');
  for (const required of REQUIRED_DEPENDENCY_SOURCES) {
    if (!names.includes(required)) addError(ctx, 'dependency-lock', 'dependency-lock-missing-source', `依赖锁缺少必需来源：${required}。`, { source: required });
  }
  for (const [name, source] of Object.entries(sources)) {
    if (!SOURCE_NAME_PATTERN.test(name)) addError(ctx, 'dependency-lock', 'dependency-name-invalid', `来源名不符合 bootstrap 允许的形式：${name}。`, { source: name });
    if (!source || typeof source !== 'object') {
      addError(ctx, 'dependency-lock', 'dependency-source-invalid', `来源 ${name} 不是对象。`, { source: name });
      continue;
    }
    if (typeof source.url !== 'string' || !source.url) {
      addError(ctx, 'dependency-lock', 'dependency-url-missing', `来源 ${name} 缺少 url。`, { source: name });
    } else if (!GITHUB_URL_PATTERN.test(source.url)) {
      const kind = /^git@/u.test(source.url) ? 'SSH 形式'
        : /^git:\/\//u.test(source.url) ? 'git 协议'
          : /^https?:\/\//u.test(source.url) && !/^https:\/\/github\.com\//u.test(source.url) ? '非 GitHub 主机'
            : /^http:\/\//u.test(source.url) ? '非 HTTPS'
              : 'GitHub 路径形态不符';
      addError(ctx, 'dependency-lock', 'dependency-url-not-github-https', `来源 ${name} 的 url 未固定为 GitHub HTTPS 仓库地址（${kind}）。`, { source: name });
    }
    if (typeof source.commit !== 'string' || !source.commit) {
      addError(ctx, 'dependency-lock', 'dependency-commit-missing', `来源 ${name} 缺少完整提交号 commit。`, { source: name });
    } else if (!FULL_SHA_PATTERN.test(source.commit)) {
      const reason = /^[0-9a-f]+$/u.test(source.commit) ? `长度为 ${source.commit.length}，不是完整 40 位` : '含非小写十六进制字符';
      addError(ctx, 'dependency-lock', 'dependency-commit-not-full-sha', `来源 ${name} 的 commit 不是完整 40 位小写 Git SHA（${reason}）。`, { source: name });
    }
    if (!source.upstream || !source.license) addWarning(ctx, 'dependency-lock', 'dependency-license-unrecorded', `来源 ${name} 未记录 upstream 或 license，第三方说明无法核对。`, { source: name });
  }
}

// ---------------------------------------------------------------- 检查 3：examples JSON

async function checkExamples(ctx) {
  const directory = join(ctx.root, 'examples');
  if (!(await existsAnyKind(directory))) {
    addWarning(ctx, 'examples-json', 'examples-directory-missing', '仓库没有 examples 目录。');
    return;
  }
  await walk(ctx, directory, async (path, name) => {
    if (!name.toLowerCase().endsWith('.json')) return;
    ctx.stats.exampleFiles += 1;
    const text = await readText(ctx, path);
    if (text === undefined) return;
    if (!text.trim()) {
      addError(ctx, 'examples-json', 'example-json-empty', '示例 JSON 为空。', { file: rel(ctx, path) });
      return;
    }
    try {
      JSON.parse(text);
    } catch (error) {
      // 同上：不输出解析错误片段，只给文件与位置数字。
      addError(ctx, 'examples-json', 'example-json-unparseable', '示例 JSON 不是有效 JSON。', { file: rel(ctx, path), ...jsonPosition(error) });
    }
  }, { reportSensitive: true });
}

// ---------------------------------------------------------------- 检查 4：Markdown 本地链接

const LINK_PATTERN = /!?\[(?:[^\]]*)\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu;

/** 提取 Markdown 中的行内链接，跳过围栏代码块与行内代码。 */
export function extractMarkdownLinks(text) {
  const lines = String(text).split(/\r?\n/u);
  const links = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const stripped = line.replace(/`[^`]*`/gu, match => ' '.repeat(match.length));
    for (const match of stripped.matchAll(LINK_PATTERN)) {
      const target = match[1] ?? match[2];
      if (target) links.push({ target, line: index + 1 });
    }
  }
  return links;
}

function isExternal(target) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('//');
}

async function checkMarkdownLinks(ctx) {
  await walk(ctx, ctx.root, async (path, name) => {
    if (!/\.(md|markdown)$/iu.test(name)) return;
    ctx.stats.markdownFiles += 1;
    const text = await readText(ctx, path);
    if (text === undefined) return;
    for (const { target, line } of extractMarkdownLinks(text)) {
      if (!target || target.startsWith('#')) continue;
      if (isExternal(target)) {
        if (/^file:/iu.test(target)) addError(ctx, 'markdown-links', 'markdown-link-file-scheme', 'Markdown 链接使用 file: 方案，属于本机路径。', { file: rel(ctx, path), line });
        continue;
      }
      if (/[<>*{}|]/u.test(target)) continue; // 文档占位写法，不作为文件校验
      const clean = target.split('#')[0].split('?')[0];
      if (!clean) continue;
      let decoded = clean;
      try { decoded = decodeURIComponent(clean); } catch { /* 保留原样 */ }
      if (isAbsolute(decoded) || /^[A-Za-z]:[\\/]/u.test(decoded)) {
        addError(ctx, 'markdown-links', 'markdown-link-absolute-path', '本地链接写成绝对路径，换机后必然失效。', { file: rel(ctx, path), line });
        continue;
      }
      const resolvedPath = resolve(dirname(path), decoded.replaceAll(/[\\/]/gu, sep));
      if (!(await existsAnyKind(resolvedPath))) {
        addError(ctx, 'markdown-links', 'markdown-link-missing', '本地相对链接目标不存在。', { file: rel(ctx, path), line, target: decoded.slice(0, 200) });
        continue;
      }
      if (relative(ctx.root, resolvedPath).startsWith('..')) addWarning(ctx, 'markdown-links', 'markdown-link-outside-root', '本地链接指向仓库之外。', { file: rel(ctx, path), line, target: decoded.slice(0, 200) });
    }
  }, { reportSensitive: true });
}

// ---------------------------------------------------------------- 检查 5：本机路径/端点/凭证扫描

function firstSegmentOfDrivePath(line) {
  const match = /[A-Za-z]:[\\/]{1,2}([\w. +-]{2,64})/u.exec(line);
  return match?.[1]?.trim().toLowerCase();
}

function ruleApplies(rule, markdown) {
  if (rule.markdownOnly) return markdown;
  if (rule.nonMarkdown) return !markdown;
  return true;
}

function scanLines(ctx, path, text, markdown) {
  const file = rel(ctx, path);
  const homes = personalHomePrefixes();
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineNumber = index + 1;
    if (line.toLowerCase().includes('release-check:ignore')) continue;
    const lower = line.toLowerCase();
    for (const home of homes) {
      if (home.length > 3 && lower.includes(home)) addError(ctx, 'personal-paths', 'local-user-home-path-literal', '文本中出现当前用户主目录绝对路径。', { file, line: lineNumber });
    }
    for (const rule of ALL_RULES) {
      if (!ruleApplies(rule, markdown)) continue;
      if (!rule.re.test(line)) continue;
      if (rule.placeholderAware) {
        const segment = firstSegmentOfDrivePath(line);
        if (segment && PLACEHOLDER_FIRST_SEGMENTS.has(segment)) continue;
      }
      if (looksDummy(line)) continue;
      const message = rule.bucket === 'secrets' ? '命中凭证格式规则，仅报告文件、行号与规则编号。'
        : rule.bucket === 'endpoints' ? '命中端点规则。' : '命中本机路径规则。';
      if (rule.severity === 'error') addError(ctx, rule.bucket, rule.code, message, { file, line: lineNumber });
      else addWarning(ctx, rule.bucket, rule.code, message, { file, line: lineNumber });
    }
    for (const url of line.match(URL_PATTERN) ?? []) {
      const host = hostOf(url);
      if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') continue;
      if (looksDummy(line)) continue;
      if (isAllowedHost(host)) continue;
      if (/^\d+(?:\.\d+){3}$/u.test(host)) addError(ctx, 'endpoints', 'endpoint-ipv4-literal', '文本中出现字面 IP 端点。', { file, line: lineNumber });
      else if (/^http:\/\//iu.test(url)) addError(ctx, 'endpoints', 'insecure-http-endpoint', '文本中出现非 HTTPS 的外部端点。', { file, line: lineNumber });
      else addError(ctx, 'endpoints', 'private-endpoint-host', '文本中出现未列入白名单的外部主机，可能是真实 DSH 地址。', { file, line: lineNumber });
    }
  }
}

function hostOf(url) {
  try {
    return new URL(url.replace(/[.,;:)\]}>'"`]+$/u, '')).hostname.toLowerCase();
  } catch {
    const match = /^[a-z]+:\/\/(?:[^/@]*@)?\[?([^\]/:@]+)\]?/iu.exec(url);
    return match?.[1]?.toLowerCase();
  }
}

function isAllowedHost(host) {
  if (ALLOWED_HOSTS.has(host)) return true;
  if (host.endsWith('.example')) return true;
  return ALLOWED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

let cachedHomePrefixes;
function personalHomePrefixes() {
  cachedHomePrefixes ??= [...new Set([homedir(), process.env.USERPROFILE, process.env.HOME]
    .filter(value => typeof value === 'string' && value.length > 5)
    .map(value => value.replace(/[\\/]+$/u, '').toLowerCase()))];
  return cachedHomePrefixes;
}

async function scanSourceText(ctx) {
  await walk(ctx, ctx.root, async (path, name) => {
    if (!isTextCandidate(name)) return;
    const text = await readText(ctx, path);
    if (text === undefined) return;
    if (Buffer.byteLength(text) > MAX_SCAN_BYTES) { ctx.stats.skippedLarge += 1; return; }
    ctx.stats.filesScanned += 1;
    scanLines(ctx, path, text, /\.(md|markdown)$/iu.test(name));
  }, { reportSensitive: true });
}

// ---------------------------------------------------------------- 汇总与输出

export const CHECK_IDS = Object.freeze([
  'package-versions', 'dependency-lock', 'examples-json', 'markdown-links',
  'personal-paths', 'endpoints', 'secrets', 'sensitive-paths', 'workspace-hygiene',
]);

function buildReport(ctx, ranChecks) {
  const errors = new Map();
  const warnings = new Map();
  for (const issue of ctx.issues) errors.set(issue.check, (errors.get(issue.check) ?? 0) + 1);
  for (const warning of ctx.warnings) warnings.set(warning.check, (warnings.get(warning.check) ?? 0) + 1);
  const order = value => `${value.check}\u0000${value.code}\u0000${value.file ?? ''}\u0000${String(value.line ?? 0).padStart(6, '0')}`;
  const checks = CHECK_IDS.filter(id => ranChecks.has(id)).map(id => ({
    check: id,
    status: errors.has(id) ? 'fail' : warnings.has(id) ? 'warn' : 'pass',
    ...(errors.get(id) ? { errors: errors.get(id) } : {}),
    ...(warnings.get(id) ? { warnings: warnings.get(id) } : {}),
  }));
  const truncatedCodes = [...ctx.seenCodes.keys()].filter(key => key.endsWith('\u0000truncated')).map(key => key.slice(0, -'\u0000truncated'.length));
  return {
    ok: ctx.issues.length === 0,
    root: ctx.root,
    checks,
    issues: ctx.issues.sort((a, b) => order(a).localeCompare(order(b))),
    warnings: ctx.warnings.sort((a, b) => order(a).localeCompare(order(b))),
    summary: {
      errors: ctx.issues.length,
      warnings: ctx.warnings.length,
      ...ctx.stats,
      ...(truncatedCodes.length ? { truncatedCodes } : {}),
    },
    note: '疑似秘密仅报告文件、行号与规则编号；模式匹配不声称穷尽秘密检测，仍需人工复核。',
  };
}

/** 对单个仓库根目录执行全部发布检查，返回结构化报告（不抛异常）。 */
export async function runReleaseCheck({ root = process.cwd() } = {}) {
  const ctx = createContext(resolve(root));
  const ran = new Set(CHECK_IDS);
  if (!(await existsAnyKind(ctx.root))) {
    addError(ctx, 'workspace-hygiene', 'root-unavailable', '检查根目录不存在。', { root: ctx.root });
    return buildReport(ctx, ran);
  }
  if (!(await stat(ctx.root)).isDirectory()) {
    addError(ctx, 'workspace-hygiene', 'root-not-directory', '检查根目录不是目录。', { root: ctx.root });
    return buildReport(ctx, ran);
  }
  await checkPackageVersions(ctx);
  await checkDependencyLock(ctx);
  await checkExamples(ctx);
  await checkMarkdownLinks(ctx);
  await scanSourceText(ctx);
  return buildReport(ctx, ran);
}

/** 默认为脚本上一级目录，即集成后的仓库根目录。 */
function defaultRoot() {
  return resolve(dirname(SCRIPT_FILE), '..');
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { root: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false }));
  } catch {
    // 不回显 parseArgs 的错误文本，它可能带出用户输入的参数值。
    console.log(JSON.stringify({ ok: false, error: { code: 'invalid-arguments', message: '命令行参数无效。用法：node scripts/check-release.mjs [--root <目录>] [--help]' } }));
    return 1;
  }
  if (values.help) {
    console.log('用法：node scripts/check-release.mjs [--root <仓库或夹具目录>]\n检查：根版本一致、依赖锁固定 GitHub HTTPS + 40 位 SHA（必须含 bridge/sync）、examples JSON、Markdown 本地相对链接、本机路径/端点/凭证扫描。退出码 0 通过，1 失败。');
    return 0;
  }
  const report = await runReleaseCheck({ root: values.root ? resolve(values.root) : defaultRoot() });
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE;
if (invokedDirectly) process.exitCode = await main();
