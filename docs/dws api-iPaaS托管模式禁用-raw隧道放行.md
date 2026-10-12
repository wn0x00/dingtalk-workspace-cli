# dws api-iPaaS托管模式禁用-raw隧道放行

## 问题背景（现象 + 取证）

**现象**：OC 沙箱内执行 `dws api GET /v1.0/contact/users/me` 返回：

```json
{"error":{"category":"internal","code":5,"message":"iPaaS 托管模式不提供本地 dws api 命令"}}
```

**取证链路**：

1. `packages/aipower/src/plugin-base.ts:909`（yingdao-ai-opencode）`shell.env` hook 为每条 bash 命令注入 `DINGTALK_CLI_BASE_URL=${serverOrigin}/oc_adapter/dingtalk`；
2. `pkg/edition/managed_proxy.go:39`（dws fork）读到该变量即激活托管 hooks；`hooks.AfterPersistentPreRun` 在 Cobra 命令执行前跑 `validateManagedProxyInvocationWithAllowedCommands`；
3. `managed_proxy.go:268`（旧版）`managedProxyLocalCommands["api"]=true` 黑名单直接拒绝，**请求根本不会发出**——这就是报错截图的来源。注意错误文案是 `fmt.Errorf("iPaaS 托管模式不提供本地 dws %s 命令", top.Name())` 格式化拼接串，整句搜索搜不到，需搜片段 `托管模式不提供`；
4. 关联历史：`dws chat media upload`（本地图片→mediaId）早在 1.0.55-beta.1（commit `902e084d`，2026-07-23，修雨）随 AppKey/AppSecret OAPI 路径一起下线，导致托管环境无本地图片上传能力。

**设计意图**：托管模式的安全模型是"凭证只在 iPaaS 代理侧、沙箱零凭证、网络出口收口到 MCP 网关"。`dws api` 需要本地应用凭证直连 api.dingtalk.com，与该模型冲突，所以被拉黑。

## 根因

不是 bug，是能力缺口：托管链路（OC `/oc_adapter/dingtalk/server/:serverID` → 连接器脚本 → mcp-gw）只承载 MCP JSON-RPC 流量；raw OpenAPI 没有对应的受审计转发通道。已验证 mcp-gw **不认应用 token**（app token 打 tools/list 被拒），且平台约束是**一条连接实例只绑一种授权**（应用或用户二选一）。

## 改动

### 方案：JSON-RPC 隧道 + 脚本按路径分流（OC 零改动，脚本零换token逻辑）

`dws api` 把 raw 请求伪装成普通 `tools/call(dws_raw_api)` 发到 `${DINGTALK_CLI_BASE_URL}/server/raw`；OC 的 `/dingtalk/server/:serverID` 路由是哑透传，`raw` 只是普通 serverID，无需修改；连接器脚本按 `params.path` 分流：`/server/*` 要求用户授权，`/server/raw` 按当前设计要求应用授权，但两条分支实际均读取通用 `auth.outputs.token`。应用 token 由平台侧「应用授权」脚本的 gettoken 流程产出并缓存，执行脚本**不做任何 token 兑换**。目前只在缺 token 时明确提示；已有 token 的授权类型错配仍由上游拒绝，并未实现脚本前置识别。后续可行方案见[Token 类型错配提示调研](钉钉授权-Token类型错配-友好提示可行性调研.md)。

| 文件 | 改动 |
| --- | --- |
| `pkg/edition/managed_proxy.go` | `api` 移出 `managedProxyLocalCommands`；`validateManagedProxyInvocationWithAllowedCommands` 增加 `api` 显式放行（与 `schema` 同级的受审例外），注释说明隧道语义 |
| `internal/app/api_command.go` | `runAPI` 在凭证解析前插入托管分支：检测 `DINGTALK_CLI_BASE_URL` → `runManagedTunnelAPI` 打包 JSON-RPC 隧道请求（带 `x-ipass-*` 头，复用 `managedProxyRequestHeaders`），解析 result 内嵌的 `{status,headers,bodyBase64}` 信封交给 `HandleResponse`；`--page-all` 托管下明确拒绝；本地路径零改动 |
| `pkg/edition/managed_proxy_test.go` | 移除 api 拉黑用例，新增 api 放行断言 |
| `internal/app/api_command_test.go` | 新增 `TestCrossPlatformCoverageManagedTunnelForwardsRawRequest` / `SurfacesConnectorErrors` |
| `scripts/ipass/dingtalk-connector-main.js` | 连接器主脚本完整版：`PATHS` 加 `/server/raw`；`handleRawTunnel` 校验 method/域名白名单（api/oapi.dingtalk.com）/大小上限，应用 token 直接读 `auth.outputs.token`（授权体系托管，脚本零兑换逻辑；缺 token 时明确报错指引换绑应用授权），api 域名注入 `x-acs-dingtalk-access-token` header，oapi 域名拼 `access_token` query，与本地版 apiclient 行为一致，支持 `file.base64` multipart 上传，响应包成 JSON-RPC result 原路返回 |

## 修复后行为对照

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 托管沙箱 `dws api GET /v1.0/...` | 托管禁令，零网络请求 | 隧道 → 连接器 → api.dingtalk.com（应用 token） |
| 托管沙箱 `dws api POST /topapi/...` | 同上 | 隧道 → oapi.dingtalk.com（access_token query） |
| 托管沙箱 `dws api ... --file`（如 /media/upload） | 同上 | file.base64 → 连接器 Node FormData multipart；bodyBase64 还原为普通表单字段 |
| 托管沙箱 `dws api ... --page-all` | 同上 | 明确报"托管模式暂不支持"（防无限翻页） |
| MCP 业务命令（发消息等） | 正常 | 完全不变（用户 token 路径未动） |
| 用户授权连接收到 raw 请求 | 不可达 | 目前透传上游错误；脚本不能仅凭通用 token 字段确认授权类型 |
| 本地 CLI（无 DINGTALK_CLI_BASE_URL） | 正常 | 完全不变（本地凭证路径未动） |
| `dws api --dry-run` | 本地预览 | 本地预览（不进隧道） |

## 验证路径

- `go test ./pkg/edition ./internal/app ./internal/apiclient` 全绿（含新增隧道用例：请求转发/信封解析/连接器错误透传）；
- 早期本地 mock fetch 验证不足以证明平台 multipart 兼容；随后在真实 Node `form-data` 下复现 Blob 混用异常并修复，详见[应用授权文件上传 502 修复](钉钉连接器-应用授权文件上传502-NodeFormData兼容修复.md)。新回归覆盖文件字节、普通字段、boundary，以及 JSON/MCP 分支；
- 待真机 E2E：发布 npm fork 新版 → 沙箱镜像更新 → 连接器平台上架新脚本 → 沙箱内实跑 `dws api GET /v1.0/contact/users/me`。

## 遗留边界

1. **一条连接只绑一种授权**：平台约束，且平台执行上下文会把用户授权 outputs 过滤到只剩 `token`（refreshToken 等字段不透传），脚本无法可靠判别授权类型。错配（如用户授权连接收到 raw 请求）时上游钉钉自然拒绝（实测 errcode 88/60011），错误原样透传——已决策不做专门区分，报错语义交给上游。要同时用 MCP 业务命令和 `dws api`，需要两条连接实例（一条用户授权、一条应用授权）执行同一个连接器脚本。
2. **`--page-all` 托管不支持**：隧道单请求语义，自动翻页需 CLI 侧逐页循环（后续可做）。
3. **应用 token 缓存依赖授权体系**：gettoken 缓存（7200s）由平台侧「应用授权」脚本负责，执行脚本只读 `auth.outputs.token`，不做二次缓存。
4. **审计粒度**：raw 隧道在 iPaaS 侧的审计记录是一条 `dws_raw_api` 动作调用，具体 targetPath 在脚本日志里（`console.log`），平台侧如需字段级审计要同步动作入参 schema。
5. OC 侧动作入参 schema（`office_dingtalk_cli_forward` 对应 iPaaS 动作）需在连接器平台同步声明 `httpMethod/targetPath/query/bodyBase64/file` 字段，否则部署校验可能拒绝透传。

## 方法论沉淀

报错整句搜不到时优先怀疑 `fmt.Errorf` 格式化拼接（`%s` 占位），用短语片段 + 黑名单变量名（`managedProxyLocalCommands`）定位。托管模式行为分叉的唯一开关是 `DINGTALK_CLI_BASE_URL` 环境变量，unset 后即可区分"托管门禁"与"本地凭证"两类报错。
