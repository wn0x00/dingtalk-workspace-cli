# 钉钉 CLI 应用授权与命令通道的边界

核对日期：2026-10-12。依据仓库源码（当前工作区，含未提交的 raw 隧道改动）与既有 docs。本次仅做事实核对，未改代码、未调真实接口。

## 问题

使用「应用授权」（应用级 token）时，是不是必须用 `dws api` 开头的命令？

## 结论

**是。** 但准确表述是「凭证 ↔ 通道的绑定」，不是命令行前缀的硬性校验：

| 授权类型 | 可用通道/命令 | 不可用 |
| --- | --- | --- |
| 应用授权（应用级 access token） | `dws api`（raw OpenAPI 通道） | 所有 MCP 业务命令（chat/doc/wiki/calendar/…） |
| 用户授权（用户 OAuth token） | MCP 业务命令 | `dws api` 的自动取 token 路径 |

两种环境（iPaaS 托管 / 本地 CLI）结论一致，但成因不同。

## 证据

### A. iPaaS/OC 托管模式（`DINGTALK_CLI_BASE_URL` 存在）

| 位置 | 事实 | 含义 |
| --- | --- | --- |
| `scripts/ipass/dingtalk-connector-main.js:5-8` | `/server/<hash>` 要求用户授权；`/server/raw` 要求应用授权 | 连接器脚本按路径分流授权 |
| `internal/app/api_command.go:261` | 检测到 `DINGTALK_CLI_BASE_URL` → `runManagedTunnelAPI`，伪装成 `tools/call(dws_raw_api)` 发到 `/server/raw` | `dws api` 是 raw 通道的唯一 CLI 入口 |
| `pkg/edition/managed_proxy.go:252-257` | `api` 为显式放行的受审例外（与 `schema` 同级）；其余本地命令默认拒绝 | CLI 侧不做授权类型判别，只做命令白名单 |
| `pkg/edition/managed_proxy.go:236-241` | 托管模式禁用 `--token` / `--profile` / `--client-id` / `--client-secret` | 沙箱零凭证，无法绕过 |
| `docs/dws api-iPaaS托管模式禁用-raw隧道放行.md` | mcp-gw 不认应用 token（app token 打 `tools/list` 被拒）；一条连接实例只绑一种授权 | 应用授权连接跑业务命令必被 gateway 拒绝 |

`--page-all` 在托管隧道下明确拒绝（`internal/app/api_command.go` 托管分支），需显式逐页调用。

### B. 本地 CLI（无托管环境变量）

| 位置 | 事实 |
| --- | --- |
| `README_zh.md:632` | 「`dws api` 只自动使用企业内部应用的 App Token，不读取 OAuth User Token，也不提供 `--as user` / `--user`」 |
| `internal/auth/app_token.go:186` + `internal/app/api_command.go:52-54` | `AppTokenProvider` 全仓库唯一消费者是 `dws api` |
| `internal/app/runner.go:903-916`、`internal/app/access_token_resolve.go:92` | 业务命令经 `TokenManager` 取用户 OAuth token |
| `internal/app/auth_command.go:124` | `dws auth login --client-id/--client-secret` 用自有应用完成**用户** OAuth，仍是用户 token；明确不支持 client_credentials |

本地与应用授权的差异：本地没有「一条连接一种授权」的限制，用户 token 与应用凭证可**同时存在**，各供各自通道使用。

## 边界与例外（避免过度绝对化）

1. `dws api` 的隐藏 `--token`（`internal/app/flags.go`，`resolveRawAPIToken` 起点 `internal/app/api_command.go:377`）接受任意 token 且不做类型校验 → 手工塞 user token 可能被部分 `api.dingtalk.com/v1.0` 接口接受；但 CLI 自动路径永不用 user token（`api_command.go:377-380` 注释明确非 OAuth User Token）。托管模式下该 flag 被禁用。
2. 反向错配（用户授权连接收到 raw 请求）**不做脚本前置拦截**：`dingtalk-connector-main.js:238-240` 注释说明不专门判别，user token 会被塞进 `x-acs-dingtalk-access-token`，由上游自然报错（实测 errcode 88/60011）。原因：平台执行上下文把用户授权 outputs 过滤到只剩 `token`，无法可靠判别授权类型。详见[Token 类型错配提示调研](钉钉授权-Token类型错配-友好提示可行性调研.md)。
3. 本结论约束的是「CLI 托管/本地两条产品通道」，**不是**钉钉所有 OpenAPI 的 token 接受规则。具体接口是否接受 app token，仍要按官方契约核对。
4. `dws api` 不进入 Agent Schema，是逃生舱而非常规命令面。

## 排查方法沉淀

- 判断某凭证被哪条通道消费，最快的落点是搜「凭证 Provider 的引用点」：`rg -n "AppTokenProvider" internal/ pkg/ --glob '!*_test.go'` → 只有一个消费者即说明绑定关系。用户侧同理搜 `TokenManager` / `GetTokenSnapshot`。
- 托管模式行为分叉的唯一开关是 `DINGTALK_CLI_BASE_URL`；unset 后即可区分「托管门禁」与「本地凭证」两类报错。
- 命令白名单看 `managedProxyBusinessCommands` / `managedProxyLocalCommands`（`pkg/edition/managed_proxy.go`），不要凭 `dws --help` 推断托管可用范围。
