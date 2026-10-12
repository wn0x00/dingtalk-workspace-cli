---
title: "钉钉 raw API 上传失败：Node FormData 与 Web Blob 混用"
date: 2026-10-10
tags: [dingtalk, ipaas, multipart, form-data, cli]
---

# 钉钉连接器应用授权文件上传 502

## 问题背景与取证

托管环境中，用户授权的普通业务命令和应用授权的纯 JSON `dws api` 请求正常；`dws api ... --file` 则返回：

```text
托管 raw API 隧道返回 HTTP 502:
IPAAS App工具调用失败，source.on is not a function，工具「钉钉」
```

对照三个仓库的实际代码：

| 链路 | 文件处理方式 | 证据 |
| --- | --- | --- |
| 飞书 CLI | 解析 multipart，先把文件 PUT 到 OSS，转发 URL descriptor | `lark-cli/ipasstrans/upload.go` 的 `buildMultipartProxyBody` / `uploadMultipartPart` |
| 飞书连接器 | 下载 descriptor 的 URL 得到 Buffer，再用 Node FormData 组 multipart | `lark-cli/ipaas_action.js` 的 `appendMultipartValue` |
| 钉钉普通聊天文件上传 | MCP 获取上传凭据 → CLI 直接 HTTP PUT 文件 → MCP 提交上传 | `internal/helpers/chat.go` 的 `uploadConversationLocalFile` |
| 钉钉 raw API 上传 | CLI 把文件打成 `file.base64`，同时把 `--data` 打成 `bodyBase64`；连接器解码并构造 multipart | `internal/app/api_command.go` 的 `runManagedTunnelAPI`；`scripts/ipass/dingtalk-connector-main.js` 的 `handleRawTunnel` |
| OC 适配器 | 只把 JSON-RPC 请求重新编码为 `bodyBase64` 转给执行器；执行器抛异常时返回 502 | `yingdao-ai-opencode/packages/aipower/src/routes/oc.ts` 的 `dingtalkRequest` 和 `/dingtalk/server/:serverID` |

因此，普通文件上传成功并不能验证 raw 分支的 multipart 实现；两条路径在文件传输方式上不同。

## 根因

### Node FormData 接收了 Web Blob

旧钉钉脚本使用浏览器 FormData 的文件调用方式：

```js
form.append(fileUpload.field, new Blob([fileUpload.bytes]), fileUpload.fileName);
```

飞书实际脚本使用 Node `form-data` 的接口：

```js
form.append(key, file.buffer, {
  filename: value.filename,
  contentType: file.contentType,
  knownLength: file.buffer.length,
});
```

用本机已有的真实 Node `form-data@4.0.5` 执行旧钉钉脚本，在没有外部网络请求的条件下复现完全相同的异常：

```text
TypeError: source.on is not a function
  at DelayedStream.create
  at CombinedStream.append
  at FormData.append
  at handleRawTunnel
```

Node `form-data` 把既非字符串又非 Buffer 的 Blob 当作流交给 `delayed-stream`，后者调用 `source.on('error', ...)` 时失败。异常发生在 `form.append`，早于 `fetch`，所以本次错误无法用于判断钉钉权限或业务参数是否正确。线上具体依赖版本未查询；源码、真实库复现与报错一致支持这一定位。

### 有文件时丢弃了普通表单字段

CLI 已同时传递 `file` 和 `bodyBase64`。旧脚本却采用 `if (args.file) ... else if (args.bodyBase64)`，存在文件时完全跳过请求体，后面只 append 文件。

因此 `--data '{"type":"image"}'` 不会变成 multipart 的 `type` 字段。只替换 Blob 仍不足以恢复 `--file` 与 `--data` 同时使用的语义。

## 改动

| 文件 | 最终改动 |
| --- | --- |
| `scripts/ipass/dingtalk-connector-main.js` | 独立解码 `bodyBase64` 与文件；上传时把 JSON 对象还原为普通表单字段；文件使用 Buffer + `filename/contentType/knownLength`；用 `getHeaders()` 设置正确 boundary；拒绝 multipart 字段名与文件名中的换行 |
| `scripts/ipass/dingtalk-connector-main.test.mjs` | 将真实 Node `form-data` 注入脚本上下文，序列化 multipart 后用 Web Request 的 multipart 解析器独立读取，检查文件字节、文件名、字段和鉴权；检查 JSON 和用户 MCP 分支 |

修复后的关键文件参数：

```js
form.append(fileUpload.field, fileUpload.bytes, {
  filename: fileUpload.fileName,
  contentType: 'application/octet-stream',
  knownLength: fileUpload.bytes.length,
});
Object.assign(requestHeaders, form.getHeaders());
```

普通字段编码与本地 Go `multipartFieldValue` 保持一致：字符串原样，其他 JSON 值编码为 JSON 字符串。这里采用 Node FormData 接口，运行环境需提供 Node `form-data`，与飞书实际连接器脚本的要求一致。

## 修复后行为与验证

在 `form-data@4.0.5` 和 `form-data@2.5.6` 下分别运行 5 个回归用例，均通过：

1. `/media/upload`：二进制文件、文件名、`type=image`、数字/布尔/对象/数组/null 字段，以及旧 OAPI 的 query token 均正确；响应信封保留业务响应和 request ID。
2. 不带 `--data` 的文件上传：自定义文件字段和新 API header token 正确。
3. 纯 JSON raw 请求：请求体字节和 JSON Content-Type 正确。
4. 用户 MCP 分支：JSON-RPC 字节、Bearer token 和 `x-user-access-token` 正确。
5. 非对象或无效 JSON 的 multipart `--data`：在 fetch 前明确拒绝。

脚本语法检查及 `git diff --check` 通过。测试不访问真实钉钉，也不发送消息。

回归测试的运行方式（先安装或指定实际 Node `form-data` 模块）：

```bash
node --check scripts/ipass/dingtalk-connector-main.js
node --test scripts/ipass/dingtalk-connector-main.test.mjs
# 若 form-data 位于其他工作区，指定模块入口的绝对路径：
DWS_IPASS_FORM_DATA_MODULE=/path/to/form-data/lib/form_data.js \
  node --test scripts/ipass/dingtalk-connector-main.test.mjs
```

## 遗留边界

- 本次完成本地脚本修复和真实库序列化验证，尚未更新连接器平台的执行脚本，也未完成真实钉钉上传验收。平台替换脚本后，才会影响现有沙箱调用；这两处修复不需要改 OC 适配器或重新编译 CLI。
- 授权类型、API 权限和接口参数仍由真实钉钉验收。本次只确认它们不是 `source.on` 异常的发生位置，不能从本地回归推断线上上传必然成功。
- `--dry-run` 明确不打开文件、不读 stdin、不发请求；预览成功只证明参数与预览路径通过，不能证明真实 multipart 或 iPaaS 运行时兼容。
- raw 上传仍以 Base64 穿过 JSON-RPC，与飞书的 OSS URL descriptor 不同；现有请求大小上限包含 Base64 和 JSON 开销。大文件支持需要另行设计，不在本次修复范围内。
- 原记录提到的 `photoURL` 替代路径需按具体消息接口核对。用户 MCP 机器人封装和直接 raw OpenAPI 的参数约束不能互相推定。

## 方法论沉淀

同名 `FormData` 不代表同一 API：Web 实现接收 Blob/File，Node `form-data` 接收 Buffer/Node stream + options。验证连接器脚本时必须注入实际依赖，而不能只用 Node 原生全局 FormData 或记录参数的 mock；验证应覆盖最终 multipart 的字节和普通字段。JSON 与 MCP 对照组只能排除公共链路故障，不能覆盖文件分支。
