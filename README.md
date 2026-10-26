# Agent Dispatch Hub

让 GPT 负责理解需求、拆任务和审查结果，让 DSH 中选定的模型负责执行。Agent Dispatch Hub 把这条协作链包装为可安装、可配置的 CLI 与 MCP 工具：同事拿到仓库链接后，可以交给自己的 AI 完成环境检查、配置和验收。

它通过命名目标连接本机或远程执行环境，分别配置实例身份、DSH 工作区归属、任务执行目录、源码目录和读写范围。回执保存这些信息；切换默认目标不会改投已有任务。配置与目录不一致时明确报错。

```mermaid
flowchart LR
    U[用户需求] --> G[GPT 规划与审查]
    G --> H[Agent Dispatch Hub]
    H --> L[本机 DSH]
    H --> R[远程 DSH]
    L --> W[选定模型在映射工作区执行]
    R --> W
    W --> G
```

v0.3.0 只包含 DSH 适配器。这不是 Codex 原生子代理，也不会自动复用 Codex 模型额度或密钥；执行模型及其登录、权限和费用由 DSH 环境管理。后续后端可通过适配器接口扩展。

新版增加独立只读派工、目标端源码并发租约和有边界的文件变更记录，保留原有 DSH 接入方式。能力、升级和异常接手见 [安全执行说明](docs/README-SAFETY.md)；真实模型验收状态见 [v0.3 验证记录](docs/VALIDATION-V0.3.md)。

旧配置升级先读 [工作区与迁移说明](docs/README-PLACEMENT.md)。工作区归组与文件权限分别处理；当前读写范围作为明确的任务指令，不声称任意目录的沙箱强制隔离。

## 开始使用

需要 Node.js 22 或更新版本、Git，以及允许使用的 DSH 环境。第一次安装建议直接让 AI 阅读 [README-AI.md](README-AI.md)，按其中步骤检查和配置；该文件也提供可复制的交接提示。

已经完成配置时，在仓库目录运行：

```sh
node bin/adh.mjs doctor
node bin/adh.mjs target list
node bin/adh.mjs status --target office
node bin/adh.mjs dispatch-readonly --target office --workspace demo --text "检查当前项目并说明下一步建议。"
```

`office` 和 `demo` 是示例名称，使用配置中真实存在的目标和工作区别名。

## 按你的任务阅读

| 读者与目的 | 文档 |
| --- | --- |
| 想判断是否适合自己的工作方式 | [产品说明](docs/README-PRODUCT.md) |
| 交给 AI 安装、接入和验收 | [AI 安装交接](README-AI.md) |
| 配置本机、远程目标或处理配对 | [连接与配置](docs/README-CONNECTIONS.md) |
| 设置归属、独立任务目录及迁移旧配置 | [工作区与迁移](docs/README-PLACEMENT.md) |
| 只读调查、源码锁、文件记录及升级 | [安全执行](docs/README-SAFETY.md) |
| 修改代码、增加后端适配器 | [开发说明](docs/README-DEVELOPMENT.md) |
| 安装失败、连接失败、任务异常 | [故障排查](docs/README-TROUBLESHOOTING.md) |
| 查看依赖来源和许可边界 | [第三方说明](docs/THIRD-PARTY.md) |

v0.2 已在选定的 Windows 本机 DSH rc.3 完成真实归组、独立 cwd、模型产物及 MCP 入口验证。远程真实实例尚未验收，协议与跨系统路径使用模拟测试；详情见 [验证记录](docs/VALIDATION-V0.2.md)。
