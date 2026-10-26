# 独立消息与调度的工程结构

需求是让没有 Hub 派工回执的 DSH 会话，也能把问题交给项目顾问。已有任务内 `hub_answer` 管理的是任务的下一轮输入，不能承担独立成员身份、离线收件箱和顾问执行调度。新能力保留原派工层，使用单独目录，避免给 `Hub` 增加团队调度职责。

```text
src/team/
  store.mjs             短事务、原子持久化与损坏状态拒绝
  service.mjs           项目/成员配置、消息准入、回执、预算
  scheduler.mjs         领取、模型准入、完成、回信与显式恢复
  codex-app-server.mjs  stdio 协议、专属线程、实际模型与只读策略
  dsh-endpoint.mjs      原实例/映射/会话核验，排队回信与确认
  http.mjs              成员凭据认证、仅发信/读取的 HTTP 入口
  install.mjs           本机新消息插件安装与受保护连接目录册
  cli.mjs               CLI 参数与上述服务的组合
packages/dsh-messaging/
  lib/client.mjs        目标机器上的受保护连接与 HTTP 客户端
  lib/index.mjs         原生 DSH 工具及真实调用会话身份
```

CLI/MCP 组合服务，不承载状态机。存储不依赖 DSH/Codex，调度器通过 `advisorFactory` 与 DSH 端点交互，测试替换这两端，不伪造真实推理成功。未来增加执行端时，在适配器层扩展；多人群聊、任务转交和共享源码租约另行设计，不混进收件箱事务。

## 配置与路由怎样固定

配置把本机顾问 cwd 与 DSH 目标机路径分开。DSH 成员保存目标连接指纹、实例身份、映射摘要、工作区 ID 和允许的会话目录。消息保存来源会话及实际目录快照，后续回信重新核对同一绑定。默认目标改变不会改投，路径按 DSH 的 win32/posix 规则计算，控制端不对远程路径做 realpath。

项目路由绑定不可变，运行预算和启停由本机负责人单独调整。成员凭据对应具体 DSH 项目身份，HTTP 不能任意选择 from、发起进程、修改配置或读取另一个成员的收件箱。本地 CLI/MCP 属于控制器所有者能力，不能作为不可信成员凭据发放。

## 状态与外部调用顺序

`queued → processing → answered → delivery-pending → delivered` 是成功路径。`processing` 的持久准入阶段区分 `claimed`、`thread-pending`、`thread-ready`、`turn-pending`、`running`。模型失败或断线分别保留 `failed` / `uncertain`；预算不足与过期分别为 `budget-exhausted` / `expired`。

先领取并占用该顾问的成员槽位，再创建/恢复 Hub 自己创建的线程。模型启动前记录准入和预算，确认后保存 turnId；不知道是否已启动时只读核对，不重新调用 `turn/start`。一个项目的顾问槽位防止同一顾问并发启动多轮；别的项目可独立被其他 worker 领取。忙的 DSH 回信不阻止继续领取其他请求。

回信前核对原 DSH 空闲和队列状态，先保存唯一 requestId/游标，再调用 queue prompt。丢失确认后只能检查历史/收件箱。投递成功表示入队，不代表下游执行完成。原生 API 不保证相同 ID 重发幂等，因此控制器绝不靠重复发送来“重试”。

正常完成与恢复可以同时观察到同一结果。提交回复按内容幂等，已回信状态不会被晚到完成重开；不同回复报冲突。晚到失败也不能向已确认成功的回执添加旧错误。短事务不包围网络或模型等待，锁冲突重试仅用于确定尚未进入的本地事务。

## 采用小规模 JSON 存储的原因

第一版的成员和队列规模有限，继续复用仓库已有的原子 JSON 与可观察文件锁，减少部署依赖。一个事务更新项目计数、消息和顾问槽位，避免多个独立文件失去一致性；同步 mutator 禁止外部异步工作。损坏、符号链接、超限及遗留锁明确拒绝，不覆盖旧状态。`TeamStore.read/transaction` 是后续替换 SQLite 等后端的边界，不让文件路径散落在调度器中。

## 协议与版本边界

参考 [官方 App Server](https://learn.chatgpt.com/docs/app-server)，并以本机生成 schema 和原生联调核实。所验版本使用稳定的 initialize、thread/start/resume/read、turn/start 及完成通知；不依赖 `clientUserMessageId` 去重或新版任意读取根字段。配置采用完整嵌套表禁用继承工具，避免单独覆盖 enabled 后丢失 MCP transport。没有推理的空线程可能不持久化，明确拒绝与丢失确认必须分别处理。

顾问会话独立于桌面主对话。模型沿用初次创建时 CLI 默认值，后续依据原生恢复结果记录实际模型/强度，不擅改全局设置。计数控制启动次数，超时控制等待期限；token 使用是观测数据，不等于货币账单硬上限。
