# 开发说明

开发入口是 Node.js 22+ 的 ESM 项目。先读仓库 [AGENTS.md](../AGENTS.md) 和 [接口契约](interface-contract.md)，安装依赖后运行测试。修改连接、认证或工作区路由时，同时核对 [连接说明](README-CONNECTIONS.md)。

```sh
npm ci --ignore-scripts
npm test
npm run check
node bin/adh.mjs --help
```

## 让后端可以替换

CLI 与 MCP 共用目标选择、配置、任务存储和路由层；DSH 适配器负责与固定版本 bridge 通信。v0.1.0 只实现 DSH。新增后端应向 `AdapterRegistry` 注册实现，并提供 `status`、`dispatch`、`send`、`wait`、`messages`、`cancel`、`close`，不让通用路由依赖新后端的会话细节。

派发时先解析目标与工作区，再保存任务回执。`dispatch` 必须在创建会话和接纳提示后分别等待 `onAdmitted` 回调，把已确认的会话 ID、请求 ID 和游标落盘；等待失败时返回可恢复的 `jobId`。后续操作从回执取目标，核对原连接后调用适配器。不要重新读取默认目标来路由已有任务，也不要把远程路径转换成本机路径。

`wait` 不持有长时间写锁，因此用户仍可追加任务或取消。回写前比较请求 ID 和游标：旧等待结果不会覆盖新追加任务。`send` 和 `cancel` 的短期修改使用每任务文件锁；异常退出遗留的 `.lock` 应先核对记录的进程是否已退出，再由接手 AI 处理，不能直接删除活动进程的锁。

## 管理外部源码

`dependencies.lock.json` 保存外部 Git URL 和完整 SHA；bootstrap 在用户状态目录的 `dependencies` 下克隆并校验，安装时禁用生命周期脚本。DSH 适配器加载固定版本 bridge 的 `scripts/dsh-client.mjs`。更新依赖时同时复核来源、提交和 [第三方说明](THIRD-PARTY.md)。

bridge 连接选项通过单次调用的环境对象传递，不修改全局 `process.env`。本机使用明确 connection file，远程使用显式 HTTPS 地址及受保护的 Cookie/token。不要把凭据带入抛出的异常、序列化配置或快照。

## 验证范围要与结论对应

单元测试使用一次性目录和模拟服务，重点覆盖未知目标、未映射工作区、目标切换、连接变更、跨 origin 凭据、HTTP 拒绝及脱敏。模拟服务测试不能证明实际 DSH 版本兼容或模型能够执行。

真实验收使用 `smoke --target <目标> --workspace <别名>`，只在指定工作区中新建独立子目录。它会触发模型调用，应与普通测试分开运行。记录非敏感版本、目标名称、步骤结果和真实文件产物；不要提交用户配置、凭据或公司项目数据。

文档与实现发生差异时以实际代码核查并同步修正。版本发布应分别说明自动测试、模拟服务验证、真实 DSH/模型验收及仍未验证的平台或场景。
