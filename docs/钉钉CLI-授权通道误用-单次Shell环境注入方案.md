# 钉钉 CLI 授权通道误用与单次 Shell 环境注入

核对日期：2026-10-12。仅完成源码调研与方案，未增加运行时检查、发布 CLI 或调用真实钉钉接口。

## 结论与前提

工程层已经知道本次选中授权为应用或用户时，可以实现「每次 bash 注入授权类型 → CLI 拒绝错误命令 → 模型看到纠正提示」。现有 OpenCode 有环境注入 Hook，钉钉 CLI 有托管命令检查入口，两处均可复用。

**环境变量只传递信息；检查代码才执行限制。** 本方案建议新增 `DINGTALK_CLI_AUTH_MODE=application|user`，当前两个仓库没有实现这个变量。它不会切换凭据，也不会将任意业务命令自动转换为等价 OpenAPI 调用。

约束范围是当前 iPaaS 托管产品通道：应用授权供 `dws api` 的 raw 通道使用，用户授权供固定 MCP 业务命令使用。不能据此推断所有钉钉 OpenAPI 都只接受应用 token。本地 CLI 可以同时配置两类凭据，不应套用「整次调用只选择一个托管授权」的限制。

## 当前证据与接入点

| 仓库与位置 | 已有能力 | 建议改动 |
| --- | --- | --- |
| `yingdao-ai-opencode/packages/aipower/src/plugin-base.ts` 的 `shell.env` Hook | 接收 sessionID、callID、messageID，每次 shell 执行前触发 | 从本次实际绑定的授权元数据读取 mode，写入 output.env |
| `yingdao-ai-opencode/packages/aipower/src/plugin/shell-env.ts` | 已注入 DINGTALK_CLI_BASE_URL 和 IPASS_SESSION_ID 等 | 同层增加非敏感授权模式变量，不注入 token |
| `yingdao-ai-opencode/packages/opencode/src/tool/shell.ts` 的 shellEnv/run/cmd | 将 process.env 与 Hook 输出合并成新对象，作为子进程 env；每次执行调用 Hook | 复用现有路径，无需改上游 shell 实现 |
| `pkg/edition/managed_proxy.go` 的 managedProxyPreRun | 根据 Cobra 实际解析的命令执行托管白名单检查 | 增加授权模式检查，保留原有本地凭据禁用与命令白名单 |
| `internal/app/root.go` 的 PersistentPreRunE | 调用 edition 检查后才进入命令执行 | 在业务运行、MCP 初始化和 raw 请求之前拒绝错配 |
| `yingdao-ai-opencode/packages/business-agent/src/index.ts` 的 Runtime.syncProxy | 按 provider kind 注册单一 executor | 元数据必须与该 executor 实际使用的连接一致；不能任取一条同名连接 |

现有命令树声明与业务 runner 的请求执行分开；`runner.Run` 在执行阶段才解析运行授权并调用传输。实施时仍应通过传输计数验证错配没有触发 initialize/tools/list/tools/call 或 raw 上游请求，不能仅凭错误文本认定零请求。

## 注入方式

首选在 `shell.env` Hook 写子进程环境，不拼接或改写模型生成的 bash 字符串。建议契约示意：

```ts
// 示意：actualDingTalkAuthMode 来自工程已有的本次实际授权信息。
// 需要新增元数据读取逻辑，当前 Hook 没有该字段。
output.env.DINGTALK_CLI_AUTH_MODE = actualDingTalkAuthMode
```

增加 CLI 检查后的单进程调用示例：

```bash
env DINGTALK_CLI_AUTH_MODE=application dws api GET /v1.0/microApp/allApps
```

例子假定已有 `DINGTALK_CLI_BASE_URL` 托管地址。这不是当前版本即可启用检查的命令；CLI 必须先实现变量消费。

不要写入全局 `process.env`，避免并发调用互相覆盖。Hook 注入覆盖一次 shell 执行及其继承环境的子进程；同一段 bash 中多个 dws 命令会默认继承同一个模式。需要使用不同连接时，应拆分调用，并同时选择对应的连接与元数据。

环境变量不会自动出现在模型上下文中。为了减少第一次误调用，还应将当前授权与命令选择规则写入本次提供给模型的指令；应用模式需明确介绍 `dws api`，因为它目前不是 Agent Schema 的普通业务命令。

## CLI 执行规则与提示

检查实际 Cobra 命令，不用字符串包含或正则识别 bash。这样能覆盖命令别名与全局参数位置，而无需解释管道、脚本或变量展开。

| 本次授权 | 命令 | 行为 |
| --- | --- | --- |
| application | api | 通过授权通道检查，继续原有参数和接口校验 |
| application | 原本允许的 MCP 业务命令 | 本地拒绝，提示使用应用接口或切换用户授权 |
| user | 原本允许的 MCP 业务命令 | 通过授权通道检查，继续原有校验 |
| user | api | 本地拒绝，提示使用用户业务命令或切换应用授权 |
| 任一种 | help/schema 等已允许的本地发现入口 | 保留发现能力，不能把它们误判为业务请求 |
| 任一种 | 原本禁止的本地管理、凭据或扩展命令 | 保留原有禁止规则，不能因模式匹配而放行 |

提示示例：

> DINGTALK_AUTH_MODE_MISMATCH：当前连接为【应用授权】，dws chat … 需要【用户授权】。如果该功能有应用 OpenAPI，请改用 dws api 调用对应接口；否则请切换用户授权连接。请勿重复执行相同命令。

> DINGTALK_AUTH_MODE_MISMATCH：当前连接为【用户授权】，当前托管 dws api 通道需要【应用授权】。请改用相应的用户业务命令，或切换应用授权连接。

错误应非零退出并让 bash 工具输出包含完整提示；结构化输出的 code/details 需遵循仓库既有错误契约。不会自动重试原命令，也不伪造未经核对的替代接口。

## 强制范围与授权切换

CLI 检查能可靠拦住普通误用，但 bash 可以覆盖或 unset 环境变量、绕过 wrapper 或直接请求适配器。最终限制必须由适配器/连接器依据实际选中的授权做复核，不能信任调用方自报的 mode。错配按[授权提示调研](钉钉授权-Token类型错配-友好提示可行性调研.md)返回可读的协议错误，避免中文提示被通用 HTTP 502 吞掉。

授权切换后，下一次 shell 执行应重新取得 mode；已启动的子进程不会随授权切换更新环境。适配器需要按本次实际解析出的凭据复核。若 bash 开始后连接变化，返回明确的错配/配置变化提示，不能让过期元数据决定凭据类型。

上线需确定缺失值策略：旧 CLI 或旧工程未注入时可先保留原行为完成分阶段部署；启用强制约束后，工程必须总是传入已确定的类型，缺失、unknown 或非法值应给出配置错误，不能默认为应用或用户。用户尚未授权时仍需保留原授权流程，不能因为没有 mode 把授权入口全部封死。

## 不改 CLI 的替代方案

- PATH 中放置 dws wrapper：能快速在调用前检查模式并提示，再调用真实二进制。需要正确处理全局参数和别名，且绝对路径调用可以绕过，适合作为过渡。
- 在 OC 适配器直接检查实际授权与 `/server/raw` / MCP 路径：即使现有 CLI 不读取新变量也能强制拒绝错配，是最终执行检查的可靠落点。
- 只注入环境或只改模型指令：能传信息或减少误用，不能独立保证错误请求被阻止。

推荐组合为「按授权提供模型指令 + shell.env 注入 + CLI 执行前检查 + 适配器复核」。无需自动改写 bash，也无需把凭据放进沙箱。

## 实施验收与方法沉淀

验收包括两类授权与两条通道的四种组合、help/schema、缺失/非法 mode、命令别名与全局参数、授权切换、并发调用及上传下载回归。错配用传输计数证明没有业务网络请求；匹配不能改变原有上传下载内容。

当前仅核对了 Hook、子进程 env 与 CLI 命令执行边界，未实现以上检查，因此不能声称新变量已生效或端到端验证通过。

可复用结论：环境注入、模型提示与执行限制是不同职责；元数据必须与最终实际使用的授权绑定一致。命令限制应在解析后的 CLI 命令与服务端路由检查，避免依赖任意 bash 文本识别。
