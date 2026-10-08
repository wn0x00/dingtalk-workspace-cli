# 影刀 iPaaS 托管授权版本

本分支是 DWS 的定制发行版。沙箱只需为当前命令进程注入一个固定的代理地址：

```powershell
$env:DINGTALK_CLI_BASE_URL = "https://adapter.example.com/dingtalk"
dws aitable --help
```

Linux/macOS：

```bash
export DINGTALK_CLI_BASE_URL=https://adapter.example.com/dingtalk
dws aitable --help
```

`DINGTALK_CLI_BASE_URL` 是唯一需要 DWS 感知的托管授权配置。DWS 不接收也不缓存 `authId`、钉钉 OAuth Token 或 `executionId`。

## 调用链路

```text
用户进入自己的沙箱会话
  -> 沙箱为本次 dws 进程注入固定 DINGTALK_CLI_BASE_URL
  -> dws 将官方 MCP 地址的 /server/<server-id> 路径改写到该 BASE_URL
  -> Adapter 根据沙箱服务端的当前用户上下文确定 authId
  -> Adapter 调用影刀 iPaaS Action
  -> iPaaS 使用平台内保存的该用户钉钉凭证访问对应 MCP/业务资源
  -> 响应沿原链路返回 dws
```

例如，官方地址：

```text
https://mcp.dingtalk.com/server/<server-id>
```

在 `DINGTALK_CLI_BASE_URL=https://adapter.example.com/dingtalk` 时变为：

```text
https://adapter.example.com/dingtalk/server/<server-id>
```

Adapter 必须从可信的服务端会话、沙箱身份或请求上下文解析当前用户，不能信任用户可修改的 `authId` 请求头、查询参数或环境变量。多用户复用同一个沙箱宿主时，每次 CLI 进程都可以使用相同 BASE_URL，但 Adapter 必须把每个请求绑定到对应用户的服务端授权记录。

## DWS 侧安全边界

设置 BASE_URL 后：

- 内置业务 MCP 使用定制代理地址，不读取本地 DWS OAuth/Keychain，也不附加 `Authorization` 或 `x-user-access-token`。
- `DINGTALK_<PRODUCT>_MCP_URL` 覆盖被禁用，避免业务请求绕开 Adapter。
- 远程代理必须使用 HTTPS；HTTP 只允许 `localhost` 或回环 IP，便于本地联调。
- BASE_URL 不允许包含用户名、密码、查询参数或 URL 片段。
- `dws api` 也通过相同 BASE_URL 转发：新版 OpenAPI 使用 `/openapi/api/<path>`，旧版使用 `/openapi/oapi/<path>`，其中 `<path>` 不带开头的 `/`。CLI 不读取本地应用凭据或 Token；请求使用何种身份及授权由平台配置决定。
- `dws auth`、`dws profile`、`dws mcp`、`dws event` 和 `dws upgrade` 在托管模式下拒绝执行。它们分别属于本地身份管理、返回或直连身份型动态 MCP 地址、长连接事件或官方二进制自更新，不属于本方案的固定代理路由。
- `dws skill get/search/install` 会访问钉钉技能市场并读取本地 OAuth，因此被禁用；只操作内置文件的 `dws skill setup` 仍可使用。
- 未设置 BASE_URL 时保持上游 DWS 的原始授权和调用行为。

Adapter 返回 401、403 或业务权限错误时，DWS 会直接返回该错误，不会回退到另一位用户的本地 Token，也不会触发本地 OAuth 刷新。

## 托管 OpenAPI

同一套命令在没有 BASE_URL 时仍采用原生应用凭据调用；设置 BASE_URL 后不需要 `dws auth login`、`DWS_CLIENT_ID`、`DWS_CLIENT_SECRET` 或 `--token`。例如：

```bash
dws api GET /v1.0/microApp/allApps
dws api POST /topapi/v2/user/get --base-url https://oapi.dingtalk.com --data '{"userid":"example-user"}'
```

当 BASE_URL 是 `https://adapter.example.com/dingtalk`，以上请求分别发送到：

```text
https://adapter.example.com/dingtalk/openapi/api/v1.0/microApp/allApps
https://adapter.example.com/dingtalk/openapi/oapi/topapi/v2/user/get
```

`--base-url` 仍表示钉钉逻辑目标，只允许官方新旧 OpenAPI 域名，不填写 Adapter 地址。代理不改变 `--params`、JSON、分页、multipart 上传或响应输出的格式。CLI 不携带钉钉 Token、Cookie、调用者指定的授权 ID；iPaaS Action 从 `context.property.auth.outputs.token` 取平台授权的 Token，新域名注入 `x-acs-dingtalk-access-token`，旧域名注入 `access_token`。不同协议必须绑定兼容的授权，MCP 用户凭证不保证可用于应用接口。

托管 OpenAPI 禁止调用者在查询参数中覆盖凭据，也禁止调用 Token/OAuth 换取端点。不跟随重定向、不自动重试业务请求、不直连回退。Token 获取与缓存仅由平台管理；同一宿主多用户时授权隔离仍由 Adapter 可信身份映射和 iPaaS 授权记录保证。

## npm 安装

正式发布后：

```bash
npm install -g @guanzhu.me/dingtalk-workspace-cli
dws --version
```

根 npm 包通过可选依赖安装当前平台的原生二进制。发布流水线同时构建 macOS、Linux、Windows 的 x64/arm64 共六个平台包。Agent Skills 已嵌入原生二进制，需要落盘或刷新时执行：

```bash
dws skill setup
```

## 版本升级和发布

`build/npm-ipass/upstream-version.txt` 是唯一的上游版本基线。例如内容为 `1.0.61` 时，自定义 npm 版本必须是 `1.0.61-ipass.N`。

升级流程：

1. 从 `upstream` 拉取目标正式 tag，并把定制改动变基或合并到该 tag。
2. 解决冲突并运行 Go 测试、npm 打包测试和真实代理链路测试。
3. 把 `build/npm-ipass/upstream-version.txt` 更新为目标上游版本。
4. 先在 GitHub Actions 手动运行 `Build and publish Yingdao iPaaS DWS npm packages`，保持 `publish_to_npm=false`，验证六平台构建。
5. 验证通过后创建 `v<上游版本>-ipass.<序号>` tag；tag 流水线会先发布六个平台包，再发布根包。

发布使用 npm Trusted Publishing（OIDC），不读取 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。7 个 npm 包都需要一次性绑定同一个 Trusted Publisher：GitHub 用户 `wn0x00`、仓库 `dingtalk-workspace-cli`、工作流文件 `publish-ipass-npm.yml`、不配置 Environment、允许 `npm publish`。绑定后，每次发布由 GitHub 托管 runner 获取短期 OIDC 身份，公开包会自动带 npm provenance。

手动工作流默认只构建和打包；只有显式启用 `publish_to_npm` 或推送匹配的定制 tag 才会发布。发布 job 固定使用 Node 24 和 npm 11.19.1，并且只授予 `contents: read`、`actions: read`、`id-token: write`。

npm 接受包后，公共注册表偶尔需要较长时间才能查询到新版本。正式流水线会先提交六个平台包，并行等待它们全部公开后再提交根包。如果任务在 npm 已接受部分包后中断，不要移动 tag，也不要重新编译同一版本；仍然手动运行 `Build and publish Yingdao iPaaS DWS npm packages`，但必须选择原版本 tag 作为运行分支，填写原 `npm_version` 和正式 tag 流水线的 `resume_run_id`，并启用 `publish_to_npm`。同一工作流会复用该 tag 任务的不可变 `npm-staging`，校验当前 ref、提交、来源、版本和包清单，跳过已经公开的包后继续通过 OIDC 发布。
