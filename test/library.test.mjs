import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveItem, searchLibrary, libraryStats, categoryOf } from '../dist/library.js';

test('library saves once, skips paywalled screens, and finds screens by metadata', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'image/png'); res.end(Buffer.alloc(64, 1)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-library-'));
  const imageUrl = `http://127.0.0.1:${server.address().port}/a.png`;
  const item = { source: 'refero-ios', kind: 'screen', id: '7', name: 'Duolingo - Paywall', app: 'Duolingo', imageUrl, tags: ['Paywall'] };
  try {
    const first = await saveItem(item, dir);
    assert.equal(first.status, 'downloaded');
    assert.equal(first.path, path.join(dir, '06-paywalls', 'duolingo', '7.png'));
    assert.equal((await saveItem(item, dir)).status, 'exists');
    assert.equal((await saveItem({ ...item, id: '8', restricted: true }, dir)).status, 'skipped');
    assert.equal(hits, 1);

    // Untagged screens fall back to the search query, then to 99-other.
    assert.equal(categoryOf({ ...item, tags: [] }, 'onboarding'), '01-onboarding');
    assert.equal(categoryOf({ ...item, tags: ['Detail'] }), '99-other');
    assert.equal(categoryOf({ ...item, tags: ['Onboarding', 'Paywall'] }), '01-onboarding');

    assert.equal(searchLibrary('duolingo paywall', 50, dir).count, 1);
    assert.equal(searchLibrary('duolingo onboarding', 50, dir).count, 0);
    const stats = libraryStats(dir);
    assert.equal(stats.images, 1);
    assert.deepEqual(stats.byFolder, { '06-paywalls/duolingo': 1 });

    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'],
      env: { ...process.env, UI_LIBRARY_DIR: dir } }));
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const name of ['ui_sources', 'search_ui', 'get_ui_screens', 'download_ui', 'library_search', 'library_stats']) {
        assert.ok(names.includes(name), name);
      }
      const viaMcp = JSON.parse((await client.callTool({ name: 'library_stats', arguments: {} })).content[0].text);
      assert.equal(viaMcp.images, 1);
      const bad = await client.callTool({ name: 'search_ui', arguments: { source: 'nope', query: 'x' } });
      assert.equal(bad.isError, true);
      assert.match(bad.content[0].text, /Unknown source/);
    } finally { await client.close(); }
  } finally { server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
