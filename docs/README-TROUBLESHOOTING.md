# 故障排查

先运行 `node bin/adh.mjs doctor`，再对用户想使用的目标运行 `status --target <目标名>`。保留脱敏后的错误、版本与目标名称即可；不要粘贴 connection file、凭据文件或认证 URL 全文。

| 现象 | 处理顺序 |
| --- | --- |
| `migration-required` | 旧路径别名缺少实例/归属/执行目录/范围。先 `target inspect`，再按 [迁移说明](README-PLACEMENT.md) 显式配置，不改正在运行的旧任务。 |
| `companion-required` / `companion-unreachable` | 在已选实例安装并加载本仓库 placement 插件，核对 profile 及其私有状态目录；不尝试其他实例。 |
| `instance-mismatch` / `instance-changed` | 当前端点与目标或回执的稳定实例身份不同；恢复原连接或使用新目标名，不覆盖旧任务绑定。 |
| `mapping-changed` | 映射在派工后改变。旧任务可按原记录读取/等待/取消，新工作使用新任务。 |
| `legacy-job-unbound` | `legacy-bind --job <id>` 显式记录旧会话实际实例与归属；它只写侧边绑定文件，不改 DSH 会话，不开启旧任务追问。 |
| 工作区缺失或归属不明确 | 对选定实例执行 `target inspect`。核对 ID 或唯一真实路径，只有显式 `onMissing:create` 才能注册现存目录。 |
| 目录缺失、cwd 漂移或范围校验失败 | 核对目标机目录、真实路径和范围。不能用工作区根、当前本机目录或其他实例静默顶替；插件不会自动恢复 cwd。 |
| 要求强制任意读写根 | 当前 DSH 没有此接口；`sandbox-required` 明确拒绝。`instructions` 仅作为任务范围约定，界面归组不授予或限制文件权限。 |
| CLI 无法启动 | 检查 Node.js 是否至少为 22、当前目录是否为仓库、依赖是否安装完整，再读取 CLI 帮助。 |
| bootstrap 拉取或安装失败 | 检查 Git、网络和固定提交是否可访问；使用锁文件中的来源，不临时换成不明 fork 或最新分支。 |
| 缺少目标或工作区 | 用 `target list` 核对名字，检查该目标的 `workspaces`；补充真实绝对路径，不用当前目录代替。 |
| 本机目标无法连接 | 检查所选 DSH profile 是否运行、connection file 是否来自该 profile，以及 loopback 服务是否可用；不要扫描其他端口或 profile。 |
| 远程返回未认证或凭据过期 | 确认 HTTPS origin 正确，再通过受保护输入重新 `target pair`；需要登录时由用户在该服务完成。 |
| 远程证书或 HTTP 报错 | 配置可验证证书的 HTTPS 服务；不要关闭 TLS 验证，也不要把凭据发送到 HTTP。 |
| 默认目标已切换，旧任务仍在原环境 | 这是回执的设计行为。对新目标创建新任务；旧 job ID 不会自动迁移。 |
| 修改连接后旧任务被拒绝 | 核对是否换了服务器、端口或 connection file。需要继续原任务时恢复原连接，不手工替换回执中的 session ID。 |
| MCP 工具不可见 | 检查 setup 的 Codex 配置位置和注册内容，按当前客户端要求重新加载或重启会话，再核对工具列表。 |
| 任务等待超时 | 查看 `messages --job <id>` 和目标状态；超时不等于任务被取消，不确定时不要重复派发同一修改任务。 |
| 模型回复成功但没有验收文件 | 检查正确目标的真实工作区及 smoke 子目录；以文件产物和内容为依据，不能只采用模型文字结论。 |

排查配置时只查看必要字段。目标名称、错误码等通常足够定位路由问题；token、Cookie、完整认证链接及含密钥的 URL 查询参数应始终隐藏。

远程主机目录、账号登录和服务部署情况不能由本机 hub 凭空得知。缺少这些信息时，明确列出所需环境信息，请用户或远程管理者补充，然后继续尚未完成的验收。
