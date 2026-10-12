import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Inject the same Node form-data implementation used by the connector runtime.
const require = createRequire(import.meta.url);
const FormData = require(process.env.DWS_IPASS_FORM_DATA_MODULE || 'form-data');
const source = fs.readFileSync(new URL('./dingtalk-connector-main.js', import.meta.url), 'utf8');
const binary = Buffer.from([0, 255, 13, 10, 128, 1]);
const upstreamBody = JSON.stringify({ errcode: 0, media_id: 'fixture-media-id' });

function inputFor(args, path = '/server/raw') {
  const rpc = {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: path === '/server/raw' ? 'dws_raw_api' : 'fixture_tool', arguments: args },
  };
  return {
    context: {
      params: {
        provider: 'dingtalk', method: 'POST', path, query: '{}',
        bodyBase64: Buffer.from(JSON.stringify(rpc)).toString('base64'),
      },
      property: { auth: { outputs: { token: 'fixture-token' } } },
    },
  };
}

function run(input, inspectRequest) {
  let calls = 0;
  const sandbox = {
    Buffer, URL, FormData,
    // No Blob is provided: this runtime accepts Node buffers and streams.
    console: { log() {}, error() {} },
    fetch: async (url, request) => {
      calls += 1;
      await inspectRequest(url, request);
      return new Response(upstreamBody, {
        status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' },
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.main(input).then((result) => {
    assert.equal(calls, 1);
    return result;
  });
}

async function parseMultipart(request) {
  const headers = new Headers(request.headers);
  assert.match(headers.get('content-type'), /^multipart\/form-data;\s*boundary=/);
  const bytes = request.body.getBuffer();
  assert.equal(request.body.getLengthSync(), bytes.length);
  return new Request('https://fixture.invalid', {
    method: 'POST', headers, body: bytes,
  }).formData();
}

test('raw upload preserves binary, filename, fields and legacy token', async () => {
  const fields = {
    type: 'image', count: 2, enabled: false, extra: { label: '图片' }, tags: ['a', 'b'], empty: null,
  };
  const result = await run(inputFor({
    httpMethod: 'POST', targetPath: 'https://oapi.dingtalk.com/media/upload', query: { test: 'yes' },
    bodyBase64: Buffer.from(JSON.stringify(fields)).toString('base64'),
    file: { field: 'media', fileName: 'fixture.jpg', base64: binary.toString('base64') },
  }), async (url, request) => {
    assert.equal(url.hostname, 'oapi.dingtalk.com');
    assert.equal(url.pathname, '/media/upload');
    assert.equal(url.searchParams.get('access_token'), 'fixture-token');
    assert.equal(url.searchParams.get('test'), 'yes');
    assert.equal(request.headers['x-acs-dingtalk-access-token'], undefined);
    const form = await parseMultipart(request);
    for (const [key, value] of Object.entries(fields)) {
      assert.equal(form.get(key), typeof value === 'string' ? value : JSON.stringify(value));
    }
    const file = form.get('media');
    assert.equal(file.name, 'fixture.jpg');
    assert.equal(file.type, 'application/octet-stream');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), binary);
  });
  const rpc = JSON.parse(Buffer.from(result.bodyBase64, 'base64').toString('utf8'));
  const envelope = JSON.parse(rpc.result.content[0].text);
  assert.equal(envelope.status, 200);
  assert.equal(envelope.headers['x-request-id'], 'fixture-request');
  assert.equal(Buffer.from(envelope.bodyBase64, 'base64').toString('utf8'), upstreamBody);
});

test('raw upload without data preserves custom file field and new API token', async () => {
  await run(inputFor({
    httpMethod: 'POST', targetPath: '/v1.0/fixture/upload',
    file: { field: 'file', fileName: 'fixture.bin', base64: binary.toString('base64') },
  }), async (url, request) => {
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(request.headers['x-acs-dingtalk-access-token'], 'fixture-token');
    const form = await parseMultipart(request);
    assert.deepEqual([...form.keys()], ['file']);
    assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), binary);
  });
});

test('raw JSON request keeps body bytes and JSON content type', async () => {
  const json = '{"msg":"你好"}';
  await run(inputFor({
    httpMethod: 'POST', targetPath: '/v1.0/robot/oToMessages/batchSend',
    bodyBase64: Buffer.from(json).toString('base64'),
  }), (url, request) => {
    assert.equal(url.hostname, 'api.dingtalk.com');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.equal(request.body.toString('utf8'), json);
  });
});

test('MCP user branch keeps its JSON-RPC body and user token headers', async () => {
  const input = inputFor({ fixture: true }, '/server/ai-search');
  await run(input, (url, request) => {
    assert.equal(url, 'https://mcp-gw.dingtalk.com/server/ai-search');
    assert.equal(request.headers.Authorization, 'Bearer fixture-token');
    assert.equal(request.headers['x-user-access-token'], 'fixture-token');
    assert.equal(request.body.toString('base64'), input.context.params.bodyBase64);
  });
});

test('invalid multipart data fails before fetch', async () => {
  for (const json of ['[]', '{invalid']) {
    await assert.rejects(run(inputFor({
      httpMethod: 'POST', targetPath: 'https://oapi.dingtalk.com/media/upload',
      bodyBase64: Buffer.from(json).toString('base64'),
      file: { field: 'media', fileName: 'fixture.bin', base64: binary.toString('base64') },
    }), () => assert.fail('invalid data must not be sent')), /multipart --data/);
  }
});
