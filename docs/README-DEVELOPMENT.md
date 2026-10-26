# 开发说明

独立消息、成员和调度放在 `src/team`，不塞进派工 `Hub`。维护前读 [消息工程结构](MESSAGING-DESIGN.md)，入口和真实边界见 [使用说明](README-MESSAGING.md)。新执行端通过适配器注入，存储只暴露同步短事务，不包含网络等待或模型调用。


[任务内提问](README-QUESTIONS.md) 由 Hub 控制：`questions.mjs` 生成和验证回复格式，`decisions.mjs` 从原请求的最终消息中识别并保存问题，`Hub.answer` 持久化答案后沿原会话提交。目标端不增加 HTTP 接口。原始 `backendResult.completed` 表示这一轮完成，用户看到的 `result.completed:false` 表示问题尚待处理。

v0.2 的配置、准备和回执契约见 [接口说明](interface-contract.md)；DSH 原生约束、权限边界与迁移见 [工作区说明](README-PLACEMENT.md)。纯目标路径校验与目标端目录准入放在 `packages/dsh-companion/lib`，CLI/MCP 共享配置和任务路由。远程路径只作目标风格计算，真实路径操作只在目标端进行。

开发入口是 Node.js 22+ 的 ESM 项目。先读仓库 [AGENTS.md](../AGENTS.md) 和 [接口契约](interface-contract.md)，安装依赖后运行测试。修改连接、认证或工作区路由时，同时核对 [连接说明](README-CONNECTIONS.md)。

```sh
npm ci --ignore-scripts
npm test
npm run check
node bin/adh.mjs --help
```

## 让后端可以替换

CLI 与 MCP 共用目标选择、配置、任务存储和路由层；DSH 适配器组合固定版本 bridge 与本仓库配套插件。v0.2 只实现 DSH。新增后端向 `AdapterRegistry` 注册实现，接口以 [当前契约](interface-contract.md) 为准；归属准备和核验由后端提供，通用层不改后端私有记录。

派发先解析实例和映射、保存待处理回执，再调用 `prepare` 创建新会话并记录实际归属与 cwd。核验通过才发送提示，立即保存请求 ID 与游标；之后等待并再次核验。准备失败保留已知会话，等待失败返回可恢复 `jobId`。后续从回执取目标，核对原连接与稳定实例，不重新读取默认目标来路由，也不把远程路径转成本机路径。

`wait` 不持有长时间写锁，因此用户仍可追加任务或取消。回写前比较请求 ID 和游标：旧等待结果不会覆盖新追加任务。`send` 和 `cancel` 的短期修改使用每任务文件锁；异常退出遗留的 `.lock` 应先核对记录的进程是否已退出，再由接手 AI 处理，不能直接删除活动进程的锁。

## 管理外部源码

`dependencies.lock.json` 保存外部 Git URL 和完整 SHA；bootstrap 在用户状态目录的 `dependencies` 下克隆并校验，安装时禁用生命周期脚本。DSH 适配器加载固定版本 bridge 的 `scripts/dsh-client.mjs`。更新依赖时同时复核来源、提交和 [第三方说明](THIRD-PARTY.md)。

bridge 连接选项通过单次调用的环境对象传递，不修改全局 `process.env`。本机使用明确 connection file，远程使用显式 HTTPS 地址及受保护的 Cookie/token。不要把凭据带入抛出的异常、序列化配置或快照。

## 验证范围要与结论对应

单元测试使用一次性目录和模拟服务，重点覆盖未知目标、未映射工作区、目标切换、连接变更、跨 origin 凭据、HTTP 拒绝及脱敏。模拟服务测试不能证明实际 DSH 版本兼容或模型能够执行。

真实验收使用 `smoke --target <目标> --workspace <别名>`，只在指定工作区中新建独立子目录。它会触发模型调用，应与普通测试分开运行。记录非敏感版本、目标名称、步骤结果和真实文件产物；不要提交用户配置、凭据或公司项目数据。

文档与实现发生差异时以实际代码核查并同步修正。版本发布应分别说明自动测试、模拟服务验证、真实 DSH/模型验收及仍未验证的平台或场景。
