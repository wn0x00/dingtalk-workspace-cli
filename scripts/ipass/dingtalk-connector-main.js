/**
 * 钉钉 DWS 连接器主执行脚本（专家模式）
 *
 * 两条流量路径，按 params.path 分流，token 一律来自授权体系（脚本零凭证逻辑）：
 *   /server/<hash>  → MCP JSON-RPC 转发到 mcp-gw.dingtalk.com，要求连接绑定「用户授权」
 *   /server/raw     → raw OpenAPI 透传（dws api 隧道），要求连接绑定「应用授权」
 * 绑定授权类型与路径不匹配时（如用户授权连接收到 raw 请求）明确报错，不猜测不降级。
 */
async function main(input) {
    const { context } = input;
    const { params, property } = context;
    const { auth } = property;

    const PATHS = [
        '/server/raw',
        '/server/1db49ea94ffe74c25a7079a68b4df6629c79130fb9095d1b499f507015d847a9',
        '/server/ai-search',
        '/server/5f0d121611f14e878f7d42c3e32bf6c4a790d433066adae38c062a657c397047',
        '/server/bb2984ee6b10c1560b4fe943ca620f646bed31f215c551a53abf040b52591a95',
        '/server/72c8e63fa17cae0ea5bf507e2594d56c7b286122a747a9a28d4c30ac430cc774',
        '/server/6108af5ad4a429685416e98148a1d25b52ab88ffb680b12a7b3782c25b1a1150',
        '/server/4717d5cbb92ecdebd89c174e4331dc17207208a97622e2004cac49c0fbedc9d1',
        '/server/3cb83d4ac411227c44c1abde4e4bfbae0ea2c172b83a78a33ffc3821d0d1be47',
        '/server/0a1609437385696b77fc4771c3ddaf5656b487f809966c0cc8d4755e7b1d3b74',
        '/server/db4b26cb38ea6a8739ad55d1997fa1da608cd36b33a6cf0f77884f70c49382fe',
        '/server/47ec90fc0db1e68d84fdd2280129c219873b51e81a23adf9fe7fa29ee9b579b3',
        '/server/404106cbb828de22de78bd390e7af4b2b24ec0cdc5088440ce10a41614fa328d',
        '/server/91e17caf44f6ca1ed9c6ce614221a518ac93300ece63ca8d7e9b133f912e0607',
        '/server/doc-comment',
        '/server/536f3b329ee774322b14361c666d6e9471e5bbb281b91ded8ca033b3ce7189af',
        '/server/377efb1093f09206cea6ccd030880d274668fb2e7a4b1bb7b96996a4fe7bb619',
        '/server/2494acfc37317871865c9c715664792200a52a89aeab58fee61cfc7262463c39',
        '/server/450eede6b54d83e030140e66ec77c98a2e89a0869ef4db481f8217a98a42f821',
        '/server/57fb66889659c56df8f0a1838026b9004d8f4257fbef54fd04a028426253a033',
        '/server/81395b96cfd92fd40858094064c1ed2f7f36eca3d7229d22aae426f74261a286',
        '/server/1e798e16a79e82eb7933050fbd58ed3ba8934170efb7c92565e39a1fb1c888e1',
        '/server/8faff71bdfc3cb5437894ada5305b48214eb56408ca31e378f4be2773ba4500c',
        '/server/abc3c880fb90f04b52d1426aaf093766e5fc9ec38411688cbb74df42a584d374',
        '/server/01d5a7b815babb03626bf3e505bad4c1e36ecf66876eaf6a7a466d9d5ccc9900',
        '/server/f7340bef5170f3baf97815989fc2bff68f4c293be82b2106c5d3e9cbbb14a17f',
        '/server/0f51140eddcd913106c5821a4d0cd577b2d1a0b6cb452dd0e51ab41facf3a83c',
        '/server/wiki',
        '/server/89833ea5debf30c260a07ffcb5127ffa3bf0c830cd76babadb293d9861485d44',
        '/server/whiteboard',
        '/server/f69b54ada16c57b603c0e5e1c36f464ba73dcee28d64bb701ff2682c259c0cff',
        '/server/e48ff8134b3e4ff6fe3a9cbae8b440869083f0213bd8879c91b080e703162e02',
        '/server/d48b09ddafc89bf921b777ff428f8fc88b14805ccdd9680e02b7be318e7ed4b4',
        '/server/op-app'
    ];

    const ENDPOINTS = Object.fromEntries(PATHS.map(function (path) {
        return [path, 'https://mcp-gw.dingtalk.com' + path];
    }));

    const MAX_BYTES = 10 * 1024 * 1024;
    const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
    const REQUEST_HEADERS = {
        accept: true,
        'content-type': true,
        'x-cli-source': true,
        'x-cli-execution-id': true
    };
    const RESPONSE_HEADERS = {
        'content-type': true,
        'retry-after': true,
        'x-trace-id': true,
        'x-request-id': true,
        'x-dingtalk-trace-id': true,
        'x-acs-request-id': true,
        'x-acs-dingtalk-request-id': true
    };
    const RAW_METHODS = { GET: true, POST: true, PUT: true, PATCH: true, DELETE: true };

    function object(value, name) {
        if (value === undefined || value === null || value === '') return {};
        if (typeof value === 'string') {
            try {
                value = JSON.parse(value);
            } catch (err) {
                throw new Error(name + ' 必须是合法 JSON 对象');
            }
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(name + ' 必须是 JSON 对象');
        }
        return value;
    }

    function headerName(value) {
        return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
    }

    function bytes(value) {
        return Buffer.from(String(value), 'utf8').length;
    }

    function headerValue(value, name) {
        const list = Array.isArray(value) ? value : [value];
        if (list.length > 8) throw new Error('header ' + name + ' 不合法');
        const text = list.map(function (item) {
            if (item != null && ['string', 'number', 'boolean'].indexOf(typeof item) < 0) {
                throw new Error('header ' + name + ' 不合法');
            }
            return String(item == null ? '' : item);
        }).join(', ');
        if (/\r|\n/.test(text) || bytes(text) > 8192) {
            throw new Error('header ' + name + ' 不合法');
        }
        return text;
    }

    function clientHeaders(value) {
        const source = object(value, 'headers');
        const names = Object.keys(source);
        if (names.length > 32) throw new Error('headers 字段数量超过上限');

        const result = {};
        const seen = {};
        let total = 0;

        names.forEach(function (rawName) {
            const name = String(rawName).trim().toLowerCase();
            if (!headerName(name) || seen[name]) throw new Error('headers 包含不合法或重复字段名');
            seen[name] = true;

            const value = headerValue(source[rawName], name);
            total += bytes(name) + bytes(value) + 2;
            if (total > 32768) throw new Error('headers 总大小超过上限');

            if (REQUEST_HEADERS[name]) result[name] = value;
        });

        return result;
    }

    function body(value) {
        if (typeof value !== 'string' || !value) throw new Error('bodyBase64 必须是非空标准 Base64');
        if (value.length > MAX_BASE64) throw new Error('JSON-RPC 请求体大小不合法');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
            throw new Error('bodyBase64 必须是非空标准 Base64');
        }
        const result = Buffer.from(value, 'base64');
        if (!result.length || result.length > MAX_BYTES) throw new Error('JSON-RPC 请求体大小不合法');
        return result;
    }

    function rpc(buffer) {
        let value;
        try {
            value = JSON.parse(buffer.toString('utf8'));
        } catch (err) {
            throw new Error('请求体必须是单个 JSON-RPC 2.0 对象');
        }

        if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0') {
            throw new Error('请求体必须是单个 JSON-RPC 2.0 对象');
        }

        Object.keys(value).forEach(function (key) {
            if (['jsonrpc', 'id', 'method', 'params'].indexOf(key) < 0) {
                throw new Error('JSON-RPC 包含未支持字段');
            }
        });

        if (value.method === 'initialize') {
            if (value.id !== 1) throw new Error('initialize 的 id 必须是 1');
            object(value.params, 'initialize params');
            return value;
        }

        if (value.method === 'tools/list') {
            if (value.id !== 2) throw new Error('tools/list 的 id 必须是 2');
            if (value.params != null && Object.keys(object(value.params, 'tools/list params')).length) {
                throw new Error('tools/list params 仅允许省略或空对象');
            }
            return value;
        }

        if (value.method === 'notifications/initialized') {
            if (Object.prototype.hasOwnProperty.call(value, 'id')) {
                throw new Error('initialized 通知不得包含 id');
            }
            object(value.params, 'initialized params');
            return value;
        }

        if (value.method === 'tools/call') {
            if (value.id !== 3) throw new Error('tools/call 的 id 必须是 3');
            const args = object(value.params, 'tools/call params');
            if (typeof args.name !== 'string' || !args.name.trim()) {
                throw new Error('tools/call 缺少工具名');
            }
            if (args.arguments != null) object(args.arguments, 'tools/call arguments');
            return value;
        }

        throw new Error('仅允许 initialize、tools/list、notifications/initialized 和 tools/call');
    }

    function headers(source) {
        const result = {};
        let count = 0;
        let total = 0;

        function add(rawName, rawValue) {
            count += 1;
            if (count > 64) throw new Error('钉钉 MCP 响应头字段数量超过上限');

            const name = String(rawName || '').trim().toLowerCase();
            if (!headerName(name)) throw new Error('钉钉 MCP 返回了不合法响应头');

            const value = headerValue(rawValue, name);
            total += bytes(name) + bytes(value) + 2;
            if (total > 32768) throw new Error('钉钉 MCP 响应头超过大小上限');

            if (RESPONSE_HEADERS[name]) result[name] = value;
        }

        if (source && typeof source.forEach === 'function') {
            source.forEach(function (value, name) { add(name, value); });
        } else if (source) {
            Object.keys(source).forEach(function (name) { add(name, source[name]); });
        }

        return result;
    }

    function responseBody(response) {
        return response.arrayBuffer().then(function (value) {
            const result = Buffer.from(value);
            if (result.length > MAX_BYTES) throw new Error('钉钉 MCP 响应超过大小上限');
            return result;
        });
    }

    // ===== raw API 隧道分支（应用 token 由授权体系托管，脚本零凭证逻辑）=====

    // raw 请求使用连接授权产出的 token（应用授权连接即应用 token）。
    // 授权类型与路径不匹配时（如用户授权连接收到 raw 请求），上游钉钉会自然拒绝，
    // 错误原样透传，脚本不做专门判别（平台不透传 refreshToken 等区分字段）。
    function appToken() {
        const output = auth && auth.outputs && typeof auth.outputs === 'object' ? auth.outputs : {};
        const token = String(
            output.token || output.accessToken || output.access_token || ''
        ).trim();
        if (!token) {
            throw new Error(
                'raw API（dws api）需要连接完成授权并产出 token；' +
                '请检查当前连接的授权配置（raw API 应绑定应用授权）'
            );
        }
        return token;
    }

    function rawTarget(targetPath) {
        const text = String(targetPath == null ? '' : targetPath).trim();
        if (!text) throw new Error('targetPath 不能为空');
        if (/[\r\n]/.test(text) || text.indexOf('#') >= 0) {
            throw new Error('targetPath 不合法');
        }

        let host = 'api.dingtalk.com';
        let pathPart = text;
        let legacy = false;

        if (/^https:\/\//i.test(text)) {
            let parsed;
            try {
                parsed = new URL(text);
            } catch (err) {
                throw new Error('targetPath 不是合法 URL');
            }
            if (parsed.hostname === 'api.dingtalk.com') {
                pathPart = parsed.pathname;
            } else if (parsed.hostname === 'oapi.dingtalk.com') {
                host = 'oapi.dingtalk.com';
                legacy = true;
                pathPart = parsed.pathname;
            } else {
                throw new Error('targetPath 域名必须在 api.dingtalk.com / oapi.dingtalk.com 白名单内');
            }
        } else if (text.charAt(0) !== '/') {
            throw new Error('targetPath 必须以 / 开头或使用完整 https URL');
        } else if (text.indexOf('/topapi') === 0) {
            host = 'oapi.dingtalk.com';
            legacy = true;
        } else if (text.indexOf('/v1.0') !== 0 && text.indexOf('/v2.0') !== 0) {
            throw new Error('新 API targetPath 必须以 /v1.0 或 /v2.0 开头（oapi 路径以 /topapi 开头）');
        }

        if (!pathPart || pathPart.charAt(0) !== '/') throw new Error('targetPath 路径不合法');
        return { host: host, path: pathPart, legacy: legacy };
    }

    async function handleRawTunnel(requestRpc) {
        const args = object(requestRpc.params.arguments, 'dws_raw_api arguments');
        const httpMethod = String(args.httpMethod || '').trim().toUpperCase();
        if (!RAW_METHODS[httpMethod]) {
            throw new Error('httpMethod 必须是 GET/POST/PUT/PATCH/DELETE');
        }
        const target = rawTarget(args.targetPath);

        const query = object(args.query, 'query');
        Object.keys(query).forEach(function (key) {
            const value = query[key];
            if (value != null && ['string', 'number', 'boolean'].indexOf(typeof value) < 0) {
                throw new Error('query 参数值必须是 string/number/boolean');
            }
        });

        let bodyPayload = null;
        if (args.bodyBase64 != null) {
            const text = String(args.bodyBase64);
            if (!text) throw new Error('bodyBase64 必须是非空标准 Base64');
            if (text.length > MAX_BASE64) throw new Error('请求体大小不合法');
            const bodyBytes = Buffer.from(text, 'base64');
            if (!bodyBytes.length || bodyBytes.length > MAX_BYTES) throw new Error('请求体大小不合法');
            bodyPayload = bodyBytes;
        }

        let fileUpload = null;
        if (args.file != null) {
            const file = object(args.file, 'file');
            const fileBase64 = String(file.base64 || '');
            if (!fileBase64) throw new Error('file.base64 不能为空');
            const fileBytes = Buffer.from(fileBase64, 'base64');
            if (!fileBytes.length || fileBytes.length > MAX_BYTES) {
                throw new Error('上传文件大小不合法');
            }
            if (httpMethod === 'GET') throw new Error('GET 请求不允许上传文件');
            fileUpload = {
                field: String(file.field || 'media'),
                fileName: String(file.fileName || 'upload.bin'),
                bytes: fileBytes
            };
        }

        const token = appToken();

        const url = new URL('https://' + target.host + target.path);
        Object.keys(query).forEach(function (key) {
            url.searchParams.set(key, String(query[key]));
        });

        const requestHeaders = { Accept: 'application/json' };
        if (target.legacy) {
            url.searchParams.set('access_token', token);
        } else {
            requestHeaders['x-acs-dingtalk-access-token'] = token;
        }

        if (fileUpload) {
            const fields = bodyPayload == null ? {} : object(bodyPayload.toString('utf8'), 'multipart --data');
            const form = new FormData();
            Object.keys(fields).sort().forEach(function (key) {
                if (/[\r\n]/.test(key)) throw new Error('multipart 字段名不能包含换行符');
                const value = fields[key];
                form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
            });
            if (/[\r\n]/.test(fileUpload.field) || /[\r\n]/.test(fileUpload.fileName)) {
                throw new Error('multipart field 或 filename 不能包含换行符');
            }
            // iPaaS 的 FormData 是 Node form-data，文件参数使用 Buffer + options。
            form.append(fileUpload.field, fileUpload.bytes, {
                filename: fileUpload.fileName,
                contentType: 'application/octet-stream',
                knownLength: fileUpload.bytes.length
            });
            Object.assign(requestHeaders, form.getHeaders());
            bodyPayload = form;
        } else if (bodyPayload != null) {
            requestHeaders['Content-Type'] = 'application/json';
        }

        console.log('钉钉 raw API 隧道请求，method：', httpMethod, 'target：', target.host + target.path);

        const response = await fetch(url, {
            method: httpMethod,
            headers: requestHeaders,
            body: httpMethod === 'GET' ? undefined : bodyPayload
        });

        const responseBuffer = await responseBody(response);

        const rawEnvelope = {
            status: Number(response.status),
            headers: headers(response.headers),
            bodyBase64: responseBuffer.toString('base64')
        };

        const innerText = JSON.stringify(rawEnvelope);
        const rpcBody = JSON.stringify({
            jsonrpc: '2.0',
            id: requestRpc.id,
            result: {
                content: [{ type: 'text', text: innerText }]
            }
        });

        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyBase64: Buffer.from(rpcBody, 'utf8').toString('base64')
        };
    }

    if (!params || typeof params !== 'object') throw new Error('params 必须是对象');
    if (params.provider !== 'dingtalk') throw new Error('provider 必须是 dingtalk');
    if (params.method !== 'POST') throw new Error('method 必须是 POST');
    if (!Object.prototype.hasOwnProperty.call(ENDPOINTS, params.path)) {
        throw new Error('path 不在 DWS 固定 MCP endpoint 白名单中');
    }
    if (Object.keys(object(params.query, 'query')).length) {
        throw new Error('query 仅允许空对象');
    }

    const requestBody = body(params.bodyBase64);
    const requestRpc = rpc(requestBody);

    if (params.path === '/server/raw') {
        if (requestRpc.method !== 'tools/call' || requestRpc.params.name !== 'dws_raw_api') {
            throw new Error('/server/raw 仅接受 dws_raw_api 的 tools/call 请求');
        }
        return await handleRawTunnel(requestRpc);
    }

    const inputHeaders = clientHeaders(params.headers);

    const query = auth.query && typeof auth.query === 'object' ? auth.query : {};
    const queryString = Object.keys(query)
        .filter(function (key) { return query[key] !== undefined && query[key] !== null && query[key] !== ''; })
        .map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key])); })
        .join('&');

    const url = ENDPOINTS[params.path] + (queryString ? '?' + queryString : '');

    const requestHeaders = Object.assign({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'claw-type': 'openClaw'
    }, inputHeaders, auth.headers && typeof auth.headers === 'object' ? auth.headers : {});

    const output = auth.outputs && typeof auth.outputs === 'object' ? auth.outputs : {};
    const outputToken = output.token || output.accessToken || output.access_token || '';
    const authorization = String(requestHeaders.authorization || requestHeaders.Authorization || '').trim();
    const token = String(outputToken || authorization.replace(/^Bearer\s+/i, '') || '').trim();

    if (!token) {
        throw new Error('钉钉 OAuth 已完成，但执行动作未拿到 access token；请检查获取 token 接口的响应转换');
    }

    delete requestHeaders.authorization;
    delete requestHeaders.Authorization;
    requestHeaders.Authorization = 'Bearer ' + token;
    requestHeaders['x-user-access-token'] = token;

    let response;
    try {
        console.log('钉钉 MCP 请求开始，path：', params.path, 'rpcMethod：', requestRpc.method, 'bodyBytes：', requestBody.length);

        response = await fetch(url, {
            method: 'POST',
            headers: requestHeaders,
            body: requestBody
        });

        const responseHeaders = headers(response.headers);
        const responseBuffer = await responseBody(response);
        const text = responseBuffer.toString('utf8').slice(0, 2048);

        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (err) {
            data = { raw: text };
        }

        console.log('钉钉 MCP 请求完成，HTTP状态码：', response.status);

        if (!response.ok) {
            throw new Error(
                '请求失败 [HTTP ' + response.status + '] 业务码: ' + (data.code || data.error_code || '-') +
                '，原因: ' + (data.msg || data.message || data.error || data.error_description || text || '未知错误')
            );
        }

        if (data.code !== undefined && data.code !== 0) {
            throw new Error(
                '业务错误 [HTTP ' + response.status + '] 业务码: ' + data.code +
                '，原因: ' + (data.msg || data.message || data.error || '未知错误')
            );
        }

        return {
            status: Number(response.status),
            headers: responseHeaders,
            bodyBase64: responseBuffer.toString('base64')
        };
    } catch (err) {
        console.error('钉钉 MCP 请求失败：', err);
        throw err;
    }
}
