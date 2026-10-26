# AI 安装交接

目标是让接手 AI 在用户自己的机器上完成安装，连接用户指定的 DSH，并留下可核对的真实任务产物。先阅读本文件，再按实际情况阅读 [连接与配置](docs/README-CONNECTIONS.md)。不要把示例目标、远程路径或地址当成现有环境。

## 可复制给同事 AI 的提示

将下面提示直接发送给同事的 AI。接手 AI 必须能读取仓库内容，并具有在目标机器安装和配置的权限。

```text
请安装并配置 https://github.com/joodty/agent-dispatch-hub 。先读取仓库中的 README.md、README-AI.md、AGENTS.md 和 docs/README-CONNECTIONS.md，再检查实际 CLI 帮助、现有安装和配置。尚未下载时先克隆到用户选定的本机目录。

请直接完成可逆的检查、依赖安装、备份与配置合并，不覆盖现有 Codex 或 DSH 设置。检查 Node.js/Git、现有 DSH 安装与 profile、Codex 配置位置，以及 hub 的配置和目标。只有发现唯一可靠的路径时才推断；不要扫描其他浏览器会话、端口、账号或机器来猜连接。

根据用户选定的实例检查原生工作区列表，分别明确实例及连接、DSH工作区、任务cwd/生成规则、实际源码和允许读写范围。先读 docs/README-PLACEMENT.md，不从旧路径猜工作区或把归组当权限。路径按目标系统解释。远程部署由管理员处理；未获授权的实例只用模拟测试，不连接探测。

按 README-AI.md 执行 bootstrap、setup、必要的配对，再 target inspect 核实实例和工作区，用 target configure --mapping-file 显式配置v2，之后 doctor、status、smoke。先核对映射再建独立测试任务，不迁移、停止或修改已有任务。控制桌面或浏览器前先侧边确认程序和范围，收到明确同意再操作，未回复不算授权。远程配对经受保护输入，不放命令参数，只向同一HTTPS origin交换凭据。

注册 hub MCP 后检查当前 Codex 是否需要重新加载。在明确选择的 target/workspace 内运行 smoke；它会发起真实模型任务并创建独立验收子目录，可能消耗模型额度。检查任务回执、模型输出及实际文件产物，区分本机单元测试、模拟服务测试与真实模型验收。验收未通过时如实说明阻塞原因，不把原型成功当作本次安装成功。

v0.3 接入后另读 docs/README-SAFETY.md，检查 companion 的 safeRunsVersion；调查使用 hub_dispatch_readonly，修改使用 hub_dispatch，完成后使用 hub_changes 核对文件记录和锁状态。旧任务不补加新限制。源码写任务互斥；超时、取消或控制端退出不直接解锁，不因遇到锁就删除目标状态或重复派工。

不要在终端输出、聊天、日志、截图、提交或报告中打印密钥、Cookie、认证 launch URL、connection.json 全文或完整凭据对象。最终只报告版本、非敏感目标名称、选定工作区别名、各检查结果、真实产物位置和仍需人处理的事项。
```

## 1. 先确认安装对象

检查 Node.js 至少为 22、Git 可用，读取仓库的 `package.json` 和 CLI 帮助。检查用户现有 DSH、Codex 和 hub 安装，避免重复安装或选错 profile。仓库代码可以放在用户选定目录；运行状态默认写入用户主目录下 `.agent-dispatch-hub`，可用 `ADH_HOME` 或 `--home <绝对目录>` 指定。

从仓库目录安装 hub 依赖并查看入口：

```sh
git clone https://github.com/joodty/agent-dispatch-hub.git
cd agent-dispatch-hub
npm ci --ignore-scripts
npm test
npm run check
node bin/adh.mjs --help
node bin/adh.mjs doctor
node bin/adh.mjs bootstrap
```

`doctor` 是诊断，不会触发模型任务；首次运行时缺少配置可能是预期结果。`bootstrap` 按 `dependencies.lock.json` 的 Git URL 与完整提交号获取外部项目，校验提交，并禁用依赖安装生命周期脚本。它不会替用户完成 DSH 模型登录。

## 2. 配置用户要使用的环境

本机安装使用实际查明的绝对路径和 profile：

```sh
node bin/adh.mjs setup local --target office --dsh-home "<DSH绝对目录>" --profile desktop --workspace "demo=<本机项目绝对目录>" --codex-home "<Codex配置绝对目录>"
```

先加 `--dry-run` 核对探测出的原生程序路径、数据目录、profile 和工作区；确认后再执行安装。Windows 桌面版要求 DSH 已首次启动并初始化 `desktop` profile。需要变更配套组件时，先确认没有运行中的任务，再完全退出 DSH（关闭窗口可能只是收到托盘）；安装器不会强杀进程。安装后重新启动该 DSH，并保持它运行。

此步骤安装配套组件、合并设置、注册 hub MCP 并添加目标。安装包保留在选定 DSH 数据目录的 `.agent-dispatch-hub/packages`，不会引用随后被删除的临时文件。原配置有逐文件备份；TOML 的结构化合并可能重新排版注释，配置值会保留。没有唯一证据时，不猜 DSH profile、Codex 配置目录或工作区。MCP 同名冲突时可明确指定 `--mcp-name <新名称>`；已有不同配置不会被覆盖。

非 Windows 平台必须额外提供 `--dsh-cli "<已安装CLI的绝对路径>"`。它必须能管理所选 profile；桌面的 `desktop` profile 使用桌面版自带的管理入口。其他平台的自动测试不代表已经完成桌面版真机安装验收，实际支持状态见发布验证记录。

远程安装使用用户提供的 HTTPS 服务地址和服务器上的工作区：

```sh
node bin/adh.mjs setup remote --target home --url https://dsh.example.com --workspace "demo=<远程项目绝对目录>" --codex-home "<本机Codex配置绝对目录>"
node bin/adh.mjs target pair home --prepare-input
node bin/adh.mjs target pair home --from-file "<上一步返回的inputFile>"
```

配对需要该远程服务的有效 launch URL。`--prepare-input` 在 Hub 状态目录生成仓库外的私有空文件，将 URL 写入该文件后再执行 `--from-file`；也可把已有受保护输入复制到该文件，全程不回显内容。成功配对后，该受管输入文件会删除。Windows 仅接受此受管目录，POSIX 输入文件须为 0600；所有平台都拒绝 Git 工作树内的认证输入。stdin 只用于管道，交互终端输入会被拒绝以避免回显。URL 本身不能出现在命令历史或聊天中。远程 DSH 安装及模型登录由该环境的管理者处理。

## 3. 选择、连通和验收

`setup --workspace name=/path` 为兼容旧入口，只建立连接和旧路径别名，尚不能派工。安装并加载 placement 配套插件后，先只读核对，再显式配置。JSON 结构见 [示例](examples/config.example.json)，迁移和创建规则见 [工作区说明](docs/README-PLACEMENT.md)。不自动把源码路径设为任务目录。

```sh
node bin/adh.mjs target inspect office
node bin/adh.mjs target configure office --mapping-file <absolute-mapping.json> --dry-run
node bin/adh.mjs target configure office --mapping-file <absolute-mapping.json>
```

```sh
node bin/adh.mjs target list
node bin/adh.mjs target use office
node bin/adh.mjs doctor
node bin/adh.mjs status --target office
node bin/adh.mjs smoke --target office --workspace demo
```

把命令中的名称替换成前一步创建的目标和工作区。`smoke` 是主动发起的真实模型验收，只在所选工作区中新建独立子目录；它不属于 `bootstrap` 或 `doctor`。检查真实文件产物，不能只看命令退出码。

MCP 注册后重新加载，再确认原派工工具以及 `hub_inspect`、`hub_verify`、`hub_artifact` 可用。通过 `verify --job <id>` 核实工作区、初始目录与实际cwd，通过 `artifact --job <id> --path <relative-path>` 检查产物。工具不可见时先排查注册和重新加载，不重复安装模型后端。

已有对话的原生工具列表尚未刷新时，可直接调用同一 MCP，继续完成安装验收：

```sh
node scripts/call-tool.mjs hub_targets
node scripts/call-tool.mjs hub_dispatch <任务参数JSON文件>
```

任务参数使用 `{ "target": "office", "workspace": "demo", "text": "明确的任务书" }`；这里不放认证信息。此入口使用统一 Hub 的目标配置，不调用旧版固定本机的桥接入口。

长任务书可使用 CLI 的 `--text-file "<任务书文件路径>"`，替代 `--text`。验收结束引用发布验证记录，并报告本次安装自己的结果，不能沿用作者机器的结果。

## 4. 交付给使用者

报告实际运行版本、目标/工作区别名、诊断结果、真实验收结果和产物位置。说明哪些步骤只用了模拟测试，哪些步骤连接了真实 DSH；若登录、凭据或远程路径仍缺失，准确列出所缺信息。不要输出受保护文件内容。
