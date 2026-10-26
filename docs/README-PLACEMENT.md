# 工作区归属、执行目录与迁移

派工会话要出现在指定的 DSH 工作区，也要在指定目录执行。v0.2 分别配置这两件事，并将源码位置与读写范围单独记录。路径属于目标机器；本机 Windows 可以连接使用 POSIX 路径的远程实例。

## 四类配置各自负责什么

| 配置 | 作用 |
| --- | --- |
| `instance`、`connection` | 稳定实例身份、目标系统路径规则，以及连接和认证方式 |
| `dshWorkspace` | DSH 界面的会话归属；ID 只在绑定的实例内有效 |
| `execution` | 实际任务 cwd，或独立子目录的生成规则 |
| `source`、`scope` | 实际源码根目录、允许读写范围及限制方式 |

完整结构见 [配置示例](../examples/config.example.json)。`workspaces` 的键仍是 CLI 的 `--workspace` 别名，不等于原生 DSH 工作区 ID。

DSH rc.3 的原生 `session.create` 接口中，`workspaceId` 与 `cwd` 互斥。成员资格要求会话初始目录与工作区目录相同；排序接口不能挂接异目录会话。配套插件先用 `workspaceId` 创建新会话，再用公开的 `workingDirectory.set` 设置实际目录，核对成员资格和目录投影后才发模型任务。回执同时记录 `initialCwd` 和 `actualCwd`，不把前者误报为执行位置。

DSH 当前沙箱写根仍取原生工作区目录，因此本版要求任务 cwd 位于该目录内；不满足时拒绝，不自动换目录或放宽权限。源码可以单独配置。`scope.enforcement: "instructions"` 表示把范围作为任务约定发送给模型，并对插件读取产物实施范围检查；它不是对模型全部文件工具的强制隔离。要求强制读写根限制的 `sandbox-required` 当前会失败。界面分组不是权限边界。

## 创建行为必须显式声明

`dshWorkspace` 的 `id`、`path` 二选一。ID 模式只能 `onMissing: "error"`。路径模式只有 `onMissing: "create"` 才允许注册新工作区；目录必须已存在，注册不创建目录。路径匹配不唯一时拒绝。

`execution.mode: "subdirectory"` 要求已有 `root`，模板为单个目录名且包含 `{jobId}`，支持 `{date}`、`{target}`、`{mapping}`。只有 `create: true` 才新建任务目录，已有同名目录不能复用。固定目录使用 `mode: "fixed"`、`cwd`、显式 `create`；允许创建时也只创建已有父目录下的一层。

源码根目录必须存在，所有范围都在目标上核对真实路径；范围支持 `{taskCwd}`。拒绝遍历、错误系统路径、Windows 驱动器相对路径、目录边界绕过和符号链接逃逸。任务 cwd 不代表源码副本或 Git 工作树。

## 从 v1 明确迁移

1. 保留配置和正在执行的任务。更新代码及配套插件；安装器不强杀 DSH。需要退出才能更新时，先等待任务结束，由用户退出后安装。
2. 只检查指定目标：`node bin/adh.mjs target inspect <target>`，取得实例 ID、`pathStyle` 和真实工作区列表，不触发模型任务。
3. 在仓库外准备仅含 `instance`、`workspaces` 的 JSON。复制示例结构，明确选择已核对的工作区和目标目录，不从旧路径猜归属；不放认证内容。
4. 先核对 dry-run 再应用。应用前自动备份，保留其他目标和映射。

```sh
node bin/adh.mjs target configure <target> --mapping-file <absolute-mapping.json> --dry-run
node bin/adh.mjs target configure <target> --mapping-file <absolute-mapping.json>
node bin/adh.mjs smoke --target <target> --workspace <mapping>
node bin/adh.mjs verify --job <job-id>
node bin/adh.mjs artifact --job <job-id> --path <relative-artifact-path>
```

旧字符串映射继续可读，新派工返回 `migration-required`。迁移不移动、停止或修改旧会话。v1 回执访问前须显式执行 `legacy-bind --job <job-id>`，它只写 Hub 独立绑定文件，记录实际归属（可能未分组），不改原会话。旧任务不接受新追问，应新建 v2 任务。这能避免旧会话 ID 被误发到连接文件后来指向的另一实例。

切换默认目标不影响已有任务；连接或实例身份变更会拒绝旧任务操作。修改映射后，旧任务仍按原回执读取、等待、取消，但不能按新范围追问。实例更换请用新目标名。不要将插件的 `instance.json` 复制到另一机器或 profile。

## 配套插件与部署

本仓库提供 [agent-dispatch-hub-dsh](../packages/dsh-companion/README.md)：bridge 负责认证及模型消息传输，sync 负责配置同步，新插件负责实例身份、归组和目录核验。身份和托管任务记录位于 profile 私有 `stateDirectory`，不写源码仓库。

本机安装器设置 profile 独立状态目录并备份 patch。远程管理员安装同一个包，为插件配置服务器本机的私有绝对 `stateDirectory`，再按已有流程配对。远程目录创建和真实路径核验由远程插件执行，不由控制端解析。未提供连接和授权的实例只用模拟测试。

托管任务执行期间应保持插件加载。删除任务目录、改变 cwd 或源码/范围真实路径漂移都会报错，不恢复到工作区根。不要在任务执行时卸载或重新配置插件。失败准备可能留下显式创建的目录、工作区或空会话；回执保留已知会话 ID，不自动清理或重派。

## 超时与结果恢复

准备过程超时后，用 `recover --job <id>` 按原 job ID、冻结计划和原实例重新确认归属，只准备会话，不发模型提示。不要重新 dispatch 来代替恢复。恢复成功后，可显式 `send --job <id>` 发送第一条任务。

提示发送前先保存 request ID 和游标。响应不明确时返回 `prompt-admission-uncertain`，不会再接受另一条新提示；可以 `wait`，或用 `retry --job <id> --text-file <原任务文件>` 核对原请求。核对要求完全相同的原任务文本，并在历史或队列中查找原 request ID；找到才解除待确认状态，不会再次发送提示。未找到时继续报待确认，不把“暂时没看到”当作没有接纳。当前 DSH 的重复 request ID 行为不足以作为重发保证，因此不盲目重发。若始终无法确认，先人工核对并显式取消原任务，再决定是否新建任务。

目录后置核验失败仍明确报错，但已经取得的后端结果会保存在回执的 `backendResult` 中，可用 `receipt --job <id>` 查看；这不代表归属核验通过，也不允许绕过范围继续追问。MCP 对应入口为 `hub_recover`、`hub_retry`、`hub_receipt`。

固定目录 `mode: fixed` 是显式共享执行位置，多次派工可以写同一个目录，不提供任务隔离。需要避免文件互相覆盖时应使用带 `{jobId}` 的 `subdirectory`，即使两个任务来自不同映射也要明确文件写入边界。
