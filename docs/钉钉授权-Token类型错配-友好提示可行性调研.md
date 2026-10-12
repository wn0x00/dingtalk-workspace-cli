# 钉钉 Token 授权类型错配的友好提示

核对日期：2026-10-12。依据钉钉 CLI、yingdao-ai-opencode、xybot-aipower-server 与 xybot-agent-server 的本地源码；本次仅调研，不修改运行脚本或发布平台配置。

## 结论

可以实现双向提示。要准确地告诉模型“当前使用应用授权/用户授权”，必须先取得当前实际命中授权记录的可信类型标识。现有连接器仅使用通用 `auth.outputs.token`，当前 CLI/OC 代理请求也没有携带这一标识，因此单靠 token 内容、请求路径或鉴权错误码，不能保证判别正确。

推荐将实际授权定义映射为 `tokenKind=application|user|unknown`，在连接器脚本里按两条托管链路检查并返回 HTTP 200 承载的 JSON-RPC 错误。当前 CLI 和 OC 均支持这一传递方式，可以先保持其运行代码不变；前提是授权标识能由平台可靠传到脚本。如果平台只允许 token 输出，则改服务端 auth-check 与 OC 代理执行层。

补充前提：如果工程层已经知道本次实际选中的应用/用户授权，可以通过现有 `shell.env` Hook 给每次 bash 子进程注入非敏感授权类型，再给 CLI 增加执行前检查。环境变量目前没有对应的 CLI 消费逻辑，单独注入不会拦截命令；最终适配器仍需按实际授权复核。具体落点与行为见[单次 Shell 环境注入方案](钉钉CLI-授权通道误用-单次Shell环境注入方案.md)。

## 当前链路与事实

| 位置 | 当前事实 | 对方案的影响 |
| --- | --- | --- |
| `scripts/ipass/dingtalk-connector-main.js:241`、`:443` | raw 与 MCP 分支均读取 `token/accessToken/access_token`；没有判别授权类型 | 通用 token 字段存在不等于已知道身份 |
| `internal/app/api_command.go:459` | `dws api` 把请求封装为 `/server/raw` 的 `dws_raw_api` tools/call | 这条托管分支按现有设计要求应用授权 |
| `yingdao-ai-opencode/packages/aipower/src/routes/oc.ts:3326` | 代理仅传 provider/method/path/query/headers/bodyBase64 | 请求数据不包含实际授权定义 |
| `yingdao-ai-opencode/packages/aipower/src/clients/aipower-api.ts:285` | AuthCheckResult 有可选通用 authType，无 tokenKind/authCode 字段 | OAuth2/API_KEY 等认证机制不能直接替代应用/用户身份语义 |
| `xybot-aipower-server/.../ToolCredentialIpaasAppAuthService.java:175` | 从实际选中的 credential 读取 credentialTemplateCode，并产出 authCode、credentialUuid、authId | 服务端已有确定授权定义的事实来源，可扩展非敏感元数据 |
| `yingdao-ai-opencode/packages/business-agent/src/index.ts:163` | proxy Map 按 kind 注册，一个 kind 最终只有一个 executor | 当前不会因为改用 dws api 就自动挑选另一条应用授权连接 |

上表的服务端文件完整位置：`xybot-ai-power-core-ddd/xybot-ai-power-core-ddd-app/src/main/java/com/xybot/ai/power/core/ddd/app/service/ToolCredentialIpaasAppAuthService.java`。解析结果类型位于 domain-service 的 `IpaasAppRuntimeAuthResolution.java`。

脚本顶部及早期改造记录中有“授权错配明确报错”的表述，但实际运行逻辑仅在没有 token 时提供提示，错配仍由上游报错。不能以注释代替实现事实。

## 为什么不能直接猜

- 请求 `/server/raw` 只能证明调用方选择 raw 分支，不能证明当前绑定的 token 是应用 token。
- `authType=OAUTH2` 描述认证机制；未核对实际授权定义与 grant 流程前，不能将其一律映射为用户 token。
- token 的长度或前缀不是已验证的身份契约。是否包含 refreshToken 也不是稳定判断方式，执行上下文可能不透传该字段。
- 旧记录中的 errcode 88/60011 可用于定位鉴权异常，但本次没有取得“错误码只会因授权类型错配而产生”的官方契约。过期、范围不足、组织不匹配等原因必须分别处理。
- 调用额外“身份探测接口”会引入权限依赖和网络请求；探测失败同样可能源于权限不足，不适合作为可靠分类器。

## 方案 A：授权元数据 + 连接器脚本，优先采用

### 元数据来源

给两种实际授权定义明确配置身份语义：应用授权标为 `application`，用户授权标为 `user`。如平台允许扩展授权输出，可由对应取 token/响应转换脚本固定产出 `tokenKind`，并同步声明输出 schema，使主脚本可以读到，例如 `auth.outputs.tokenKind`。

以上字段是建议的新契约，当前并不存在，任意扩展输出是否会被平台保留尚需核对。不得由模型通过 `params.tokenKind` 声称身份。旧授权缓存可能没有标识，应归为 unknown，并验证新旧缓存的刷新路径。

若一份连接器定义固定只有一种授权，也可使用经核对的连接器配置常量；同一 App 支持多个授权定义时，必须按实际选中的 authCode 判断，不能仅按 connectorCode 判断。

### 行为

| 当前身份 | 请求链路 | 建议行为 |
| --- | --- | --- |
| application | 普通 MCP 业务命令 `/server/*` | 请求发往钉钉前拒绝，提示 dws api 的应用接口方案或切换用户授权 |
| user | 当前约定为应用授权的 `/server/raw` | 请求发往钉钉前拒绝，提示用户业务命令的等价能力或切换应用授权 |
| 与链路匹配 | 相应分支 | 保持现有调用 |
| unknown | 任一分支 | 不断言当前身份；保留上游错误，并仅在鉴权失败时提示核对授权类型 |

这张表约束的是当前托管 CLI 的两个产品分支，不是钉钉所有 OpenAPI 的 token 接受规则。raw 接口本身是否要求某种 token，还要按具体接口的官方契约核对。

### 模型可见的文案

应用授权错用 MCP：

> 当前连接使用【应用授权】，本次 dws 业务命令需要【用户授权】。如该功能有应用 OpenAPI，请使用 dws api 调用对应接口；如需继续使用当前命令，请切换到用户授权连接。请勿用相同授权重复重试。

用户授权错用应用 raw 分支：

> 当前连接使用【用户授权】，本次 dws api 托管分支需要【应用授权】。请改用对应的 dws 业务命令，或切换到应用授权连接后调用该应用接口。请勿用相同授权重复重试。

`dws api` 不会把应用 token 变成用户 token，也不承诺每项用户操作都有应用接口。提示应给出方向，不凭空生成未核实的 endpoint。

### 返回协议：不能仅 throw Error

`oc.ts:3394` 将执行器异常包装为 HTTP 502。普通 MCP 传输在 `internal/transport/client.go:470` 遇到非 2xx 直接生成 HTTP 状态错误，不解析响应 JSON 中的提示；该路径还可能触发 HTTP 重试。因此只在脚本里写中文 throw，无法保证模型看到提示。

已知授权错配应该作为协议内失败返回：

```js
const rpcError = {
  jsonrpc: '2.0',
  id: requestRpc.id,
  error: {
    code: -32010,
    message: 'DINGTALK_AUTH_TYPE_MISMATCH: 当前连接使用【应用授权】……',
    data: {
      reason: 'auth_type_mismatch',
      actualAuthType: 'application',
      requiredAuthType: 'user',
      retryable: false
    }
  }
};
return {
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyBase64: Buffer.from(JSON.stringify(rpcError), 'utf8').toString('base64')
};
```

这是待实现示例，不是已加入主脚本的代码。HTTP 200 表示代理成功传递错误，业务仍为失败。

OC 的 `dingtalkResponse` 会还原这个响应。普通 CLI 的 `jsonrpcEnvelopeError` 会保留 `error.message`；raw CLI 的 `runManagedTunnelAPI` 也已读取同一字段。关键提示必须写进 message：当前 raw CLI 不读取 error.data，不能只把操作指引放在 data 中。

检查还要覆盖 MCP 的 initialize/tools/list/tools/call，避免应用 token 在握手阶段提前失败。JSON-RPC notification 没有 id，不应伪造带 id 的错误响应；通常 initialize 已拒绝即可停止后续调用。

## 方案 B：服务端解析 + OC 检查

当平台无法给执行脚本保留身份标识时，从实际选中的 authCode/凭据记录建立可信映射，将非敏感的 tokenKind 增加到 auth-check 结果。OC 的 iPaaS 工具工厂在授权检查通过后、执行连接器前，检查 provider 与请求 path，然后返回与方案 A 相同的连接器响应信封。

改动涉及服务端 DTO/转换链、`AuthCheckResult` 与代理工具执行代码，比方案 A 多。不能直接在共用 iPaaS 工厂中返回 JSON-RPC 信封给所有普通工具；只对钉钉 CLI proxy 做该适配。auth-check 与最终执行需要使用一致的凭据解析规则；若默认授权可能在两次调用之间变化，最终执行层应复核，不能把过时的预检结果当作事实。

## 脚本立即可做的降级方案

尚无可信标识时，可以在已识别的鉴权失败上补“本命令需要用户/应用授权，请检查连接类型”的条件式提示，保留原始错误码、消息与 requestId。它能减少模型盲目重试，但不能实现“当前一定是应用/用户授权”的确定陈述。

普通 MCP 路径仍需把已识别的鉴权失败转为协议内错误；网络故障、限流和业务失败不能统一改成授权错配。raw 的错误信封和二进制成功响应也要保持原状。

## 实施前核对与验收

1. 用脱敏结构核对平台是否能向主脚本传实际 authCode 或声明的 tokenKind，只记录字段名和类型，不记录 token。
2. 验证两种授权对两条路径的四种组合：匹配时正常，错配时在上游请求前停止，模型能读到完整指引。
3. 检查旧缓存 unknown、token 过期、权限不足、429、网络错误、业务错误，保证没有被错误归类。
4. 检查 MCP 初始化错误可见，以及 raw/普通命令均不会因已知错配进行 HTTP 502 重试。
5. 回归原有上传、JSON 与下载响应，确保增加提示不改变这些成功结果的字节和信封。

本次验证是源码链路核对，未对真实 token 做探测、未调用真实钉钉接口、未部署授权标识或新提示。因此可以确认实现路径可行，尚不能声称新提示已上线。
