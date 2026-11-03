// Manual acceptance helper. Loopback only; never included in production startup.
import { createServer, request as upstreamRequest } from 'node:http';

const upstreamHost = '127.0.0.1';
const upstreamPort = Number(process.env.NBASE_TEST_UPSTREAM_PORT ?? 4320);
const listenHost = process.env.NBASE_TEST_PROXY_HOST ?? 'localhost';
const listenPort = Number(process.env.NBASE_TEST_PROXY_PORT ?? 4321);
if (!['localhost', '127.0.0.1'].includes(listenHost)
  || ![upstreamPort, listenPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
  || upstreamPort === listenPort) throw new Error('Test proxy requires distinct loopback ports');
const upstreamOrigin = `http://${upstreamHost}:${upstreamPort}`;
const maxBodyBytes = 2 * 1024 * 1024;
let armed = null;
let hideNextReceipt = false;
const events = [];

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('Request too large for test proxy');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isPagePatch(request) {
  return request.method === 'PATCH' && /^\/api\/workspaces\/[^/]+\/pages\/[^/]+$/.test(request.url ?? '');
}

const server = createServer(async (incoming, response) => {
  try {
    const path = new URL(incoming.url ?? '/', 'http://localhost').pathname;
    if (path === '/__nbase_test__/status') {
      return json(response, 200, { armed, hideNextReceipt, events });
    }
    if (path === '/__nbase_test__/arm' && incoming.method === 'POST') {
      const value = JSON.parse((await readBody(incoming)).toString('utf8'));
      if (!['drop-patch', 'drop-patch-and-receipt', 'invalid-patch', 'reject-patch-401', 'drop-action-and-receipt', 'delay-patch'].includes(value.mode)) {
        return json(response, 400, { error: 'INVALID_MODE' });
      }
      armed = value.mode;
      hideNextReceipt = false;
      events.length = 0;
      return json(response, 200, { armed });
    }
    if (path.startsWith('/__nbase_test__/')) return json(response, 404, { error: 'NOT_FOUND' });
    if (hideNextReceipt && incoming.method === 'GET' && /^\/api\/workspaces\/[^/]+\/mutations\/[^/]+$/.test(path)) {
      hideNextReceipt = false;
      events.push({ kind: 'receipt-hidden' });
      return json(response, 404, { error: 'NOT_FOUND' });
    }

    let body = await readBody(incoming);
    const patch = isPagePatch(incoming);
    const action = incoming.method === 'POST' && /^\/api\/workspaces\/[^/]+\/pages\/[^/]+\/(?:trash|restore|restore-version)$/.test(path);
    let fault = null;
    if (patch || action) {
      const parsed = JSON.parse(body.toString('utf8'));
      events.push({ kind: action ? 'action' : 'patch', mutationId: parsed.clientMutationId });
      if ((patch && armed !== 'drop-action-and-receipt') || (action && armed === 'drop-action-and-receipt')) {
        fault = armed; armed = null;
      }
      if (fault === 'invalid-patch') {
        parsed.content.schemaVersion = 999;
        body = Buffer.from(JSON.stringify(parsed));
        events.push({ kind: 'invalid-body-forwarded' });
      }
      if (fault === 'reject-patch-401') {
        events.push({ kind: 'rejected-401' });
        return json(response, 401, { error: 'AUTH_EXPIRED' });
      }
    }

    const headers = { ...incoming.headers, host: `${upstreamHost}:${upstreamPort}` };
    if (headers.origin) headers.origin = upstreamOrigin;
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(body);
    const upstream = upstreamRequest({
      hostname: upstreamHost, port: upstreamPort, path: incoming.url, method: incoming.method, headers,
    }, upstreamResponse => {
      if (fault === 'drop-patch' || fault === 'drop-patch-and-receipt' || fault === 'drop-action-and-receipt') {
        upstreamResponse.resume();
        upstreamResponse.once('end', () => {
          events.push({ kind: action ? 'action-committed-response-dropped' : 'patch-committed-response-dropped', status: upstreamResponse.statusCode });
          hideNextReceipt = fault === 'drop-patch-and-receipt' || fault === 'drop-action-and-receipt';
          response.destroy();
        });
        return;
      }
      if (fault === 'delay-patch') {
        const chunks = [];
        upstreamResponse.on('data', chunk => chunks.push(chunk));
        upstreamResponse.once('end', () => setTimeout(() => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          response.end(Buffer.concat(chunks));
          events.push({ kind: 'patch-response-delayed', status: upstreamResponse.statusCode });
        }, 4000));
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once('error', error => {
      events.push({ kind: 'upstream-error', code: error.code });
      if (!response.headersSent) json(response, 502, { error: 'UPSTREAM_UNAVAILABLE' });
      else response.destroy(error);
    });
    upstream.end(body);
  } catch (error) {
    events.push({ kind: 'proxy-error', message: error.message });
    if (!response.headersSent) json(response, 500, { error: 'TEST_PROXY_ERROR' });
    else response.destroy(error);
  }
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`NBase test fault proxy listening at http://${listenHost}:${listenPort}\n`);
});
