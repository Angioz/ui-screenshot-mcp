import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Page that polls forever, so "networkidle" never fires.
const html = '<body><div id="banner">cookies</div><h1 id="h">hello</h1><div style="height:3000px"></div>' +
  '<script>setInterval(()=>fetch("/ping"),100)</script></body>';

test('MCP capture survives a never-idle page and honours output/hide/delay options', async () => {
  const server = http.createServer((req, res) => { res.end(req.url === '/ping' ? 'ok' : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-screenshot-mcp-'));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  try {
    const outputPath = path.join(dir, 'nested', 'a.png');
    const call = async args => JSON.parse((await client.callTool({ name: 'capture_screenshot', arguments: args })).content[0].text);

    const idle = await call({ url, waitUntil: 'networkidle', timeout: 1500, outputPath });
    assert.equal(idle.success, true);
    assert.match(idle.warnings[0], /timed out/);
    assert.ok((await fs.stat(outputPath)).size > 0);

    const shot = await call({ url, hideSelectors: ['#banner'], scrollY: 500, delayMs: 200, deviceScaleFactor: 2,
      outputPath: path.join(dir, 'b.png') });
    assert.equal(shot.success, true);
    assert.equal(shot.warnings, undefined);
    const png = await fs.readFile(path.join(dir, 'b.png'));
    assert.equal(png.readUInt32BE(16), 1280 * 2);
  } finally { await client.close(); server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('MCP capture falls back when web fonts never finish loading, and the schema lists the new options', async () => {
  const page = '<style>@font-face{font-family:Slow;src:url(/slow.woff2)}h1{font-family:Slow,serif}</style><h1>hi</h1>';
  const server = http.createServer((req, res) => { if (req.url !== '/slow.woff2') res.end(page); }); // font request hangs
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-screenshot-mcp-'));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  try {
    const props = (await client.listTools()).tools.find(t => t.name === 'capture_screenshot').inputSchema.properties;
    for (const key of ['waitUntil', 'timeout', 'delayMs', 'hideSelectors', 'scrollY', 'deviceScaleFactor', 'outputPath']) assert.ok(props[key], key);
    const out = path.join(dir, 'font.jpg');
    const r = JSON.parse((await client.callTool({ name: 'capture_screenshot', arguments:
      { url: `http://127.0.0.1:${server.address().port}/`, format: 'jpeg', timeout: 1500, outputPath: out } })).content[0].text);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.match(r.warnings.join(' '), /CDP|retry/);
    assert.ok((await fs.stat(out)).size > 0);
  } finally { await client.close(); server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
