# 连接与配置

v0.2 的新派工需要先绑定稳定实例及原生 DSH 工作区，再独立配置执行目录、源码目录和读写范围。完整结构与迁移步骤见 [工作区与迁移](README-PLACEMENT.md)。下方连接片段保留 v1 传输格式；旧字符串工作区仅用于诊断与迁移，不能直接新派工。

每个 target 描述一个独立执行环境：采用哪个适配器、如何认证，以及哪些工作区可以接收任务。一个工作区别名只在所属目标中有效；同名别名在不同目标上可以指向不同机器的目录。

配置保存于 `<hub状态目录>/config.json`。状态目录默认是用户主目录下 `.agent-dispatch-hub`，可通过 `ADH_HOME` 或全局 `--home <绝对目录>` 指定。参考 [config.example.json](../examples/config.example.json)，替换所有示例地址和路径后再使用。

## 本机目标

```json
{
  "adapter": "dsh",
  "connection": {
    "kind": "local",
    "connectionFile": "/absolute/dsh-home/.codex-dsh-bridge/connection.json"
  },
  "workspaces": { "demo": "/absolute/local/project" }
}
```

`connectionFile` 指向用户明确选择的 DSH 配套组件连接文件，`workspaces` 指向本机真实项目目录。本机目标只接受该文件中的 loopback 地址；不会通过扫描端口、浏览器或其他 profile 自动发现连接。连接文件可能含有认证数据，不应复制到仓库、聊天或故障报告。

DSH 的 profile 与 hub 的 target 不同：profile 由 DSH 管理，target 是 hub 中方便选路的名字。`setup local` 使用 `--profile` 选择要安装的 profile。v0.1.0 的本机连接文件按 DSH 数据目录保存；同一数据目录只应启用一个发布该连接文件的 profile。多个并行本机 DSH 实例请使用独立数据目录，避免互相覆盖连接文件。

## 远程目标

```json
{
  "adapter": "dsh",
  "connection": {
    "kind": "remote",
    "baseUrl": "https://dsh.example.com",
    "credentialFile": "/absolute/user-state/credentials/home.json"
  },
  "workspaces": { "demo": "/absolute/path/on/remote/machine" }
}
```

`baseUrl` 必须使用 HTTPS，证书按系统正常规则验证。`credentialFile` 位于运行 hub 的机器，工作区路径则位于远程 DSH 所在机器；不能用本机项目路径替代它。Windows 可使用 JSON 转义后的绝对路径，例如 `C:\\work\\demo`，具体格式须符合实际目标系统。

`credentialFile` 必须是当前实际 `<ADH_HOME>/credentials/<target名称>.json`；示例里的 `/absolute/user-state` 代表你的整个 Hub 状态目录，不能另选一处目录。优先执行 `setup remote` 自动生成配置，避免手写路径与 `--home` 不一致。

远程 DSH 服务需由环境管理者先部署并提供地址及登录方式。`setup remote` 只配置本机 hub 目标和 MCP 注册，不安装或修改远程服务器。

## 配对与凭据

先运行 `node bin/adh.mjs target pair home --prepare-input`，把该服务的 launch URL 写入返回的私有空文件，再运行 `target pair home --from-file "<inputFile>"`。该受管文件配对成功后会删除；输入不得位于任何 Git 工作树。stdin 支持受保护管道输入，交互终端不会接受明文 URL。配对在配置的精确 origin 上交换认证，私下保存服务签发的 Cookie；不能把认证 URL 放到命令参数、截图、仓库或报告中。

origin 包括协议、主机和端口。为某个 origin 获取的 Cookie 或 token 只能用于该 origin，不可带到另一个主机、端口或协议。HTTP 被拒绝；不要用关闭 TLS 校验处理证书故障。

凭据过期时重新取得对应服务的有效 launch URL 并配对。需要图形登录时由用户在相应环境完成，AI 无法保证绕过登录、读取其他账户或找到未知服务的凭据。

## 选择目标与工作区

```sh
node bin/adh.mjs target list
node bin/adh.mjs target use office
node bin/adh.mjs status --target office
node bin/adh.mjs dispatch --target office --workspace demo --text "调查项目并报告结果。"
```

默认目标只是新任务的选择；首次安装时应核对 `defaultTarget`。派发仍必须有已知目标及显式映射的工作区。CLI 和 AI 都不应因缺少映射而擅自使用当前目录。

任务创建时记录目标、工作区及连接信息。后续 `send`、`wait`、`messages`、`cancel` 依据回执路由，切换默认目标不改变已有任务。目标连接改变时，旧回执将拒绝操作；先核对配置，必要时恢复原连接，不能将旧 session ID 手工搬到新服务。

## 其他 MCP 客户端

CLI 和 MCP 的派工接口可供其他兼容客户端使用。`setup` 默认注册 Codex；使用其他客户端时加 `--skip-register`，再按该客户端的配置格式注册同一个 stdio 入口。例如：

```json
{
  "mcpServers": {
    "agent-dispatch-hub": {
      "command": "node",
      "args": ["/absolute/repo/bin/adh.mjs", "mcp", "--home", "/absolute/user-state"]
    }
  }
}
```

路径均属于运行 Hub 的本机。支持设置工具超时的客户端建议设为 330 秒；默认单次等待 55 秒，超时后保存 `jobId` 并继续等待，不重复创建任务。
