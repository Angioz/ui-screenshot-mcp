import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ScreenshotRunner } from '../dist/cli.js';

const exec = promisify(execFile);
const cli = path.resolve('dist/cli.js');

test('CLI captures real viewport/full-page/element PNGs and JPEG, preserving session navigation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-mcp-test-'));
  const fixture = path.join(directory, 'fixture.html');
  await fs.writeFile(fixture, '<title>Local capture fixture</title><style>body{margin:0;height:1200px}#card{width:120px;height:80px;background:#19b4d7}</style><div id="card">Saved card</div>');
  const url = pathToFileURL(fixture).href;
  const runner = new ScreenshotRunner();
  try {
    const opened = await runner.dispatch('open_browser', { url, width: 360, height: 640 });
    assert.equal(opened.title, 'Local capture fixture');
    const viewport = await runner.dispatch('capture_screenshot', { output: path.join(directory, 'viewport.png') });
    assert.deepEqual(viewport.size, { width: 360, height: 640 });
    assert.equal(viewport.url, url);
    const metadata = JSON.parse(await fs.readFile(`${viewport.path}.json`, 'utf8'));
    assert.equal(metadata.sha256, viewport.sha256);
    assert.equal(metadata.bytes, (await fs.stat(viewport.path)).size);
    const full = await runner.dispatch('capture_screenshot', { fullPage: true, output: path.join(directory, 'full.png') });
    assert.deepEqual(full.size, { width: 360, height: 1200 });
    const card = await runner.dispatch('capture_screenshot', { selector: '#card', output: path.join(directory, 'card.png'), expectText: 'Saved card' });
    assert.deepEqual(card.size, { width: 120, height: 80 });
    const jpeg = await runner.dispatch('capture_screenshot', { format: 'jpeg', quality: 75, output: path.join(directory, 'card.jpg') });
    const jpegBytes = await fs.readFile(jpeg.path);
    assert.equal(jpegBytes.readUInt16BE(0), 0xffd8);
    await runner.dispatch('navigate', { url: `${url}?next` });
    const changed = await runner.dispatch('capture_screenshot', { selector: '#card', output: path.join(directory, 'next.png') });
    assert.equal(changed.url, `${url}?next`);
    const listed = await runner.dispatch('list_screenshots', { directory });
    assert.equal(listed.files.length, 5);
    await assert.rejects(runner.capture({ output: viewport.path }), /Refusing to overwrite/);
    await assert.rejects(runner.capture({ expectText: 'Private Instagram collection', output: path.join(directory, 'wrong.png') }), /Expected text not visible/);
    await assert.rejects(fs.access(path.join(directory, 'wrong.png')));
    await runner.dispatch('close_browser', { sessionId: opened.sessionId });
    await assert.rejects(runner.capture({}), /No active session/);
  } finally { await runner.dispose(); }
});

test('invalid options fail rather than silently capturing something else', async () => {
  const runner = new ScreenshotRunner();
  try {
    await assert.rejects(runner.open({ url: 'javascript:alert(1)' }), /HTTP/);
    await assert.rejects(runner.open({ url: 'https://example.com', browser: 'wrong' }), /Invalid browser/);
    await assert.rejects(runner.open({ url: 'https://example.com', width: 0 }), /Invalid width/);
    await assert.rejects(runner.capture({ format: 'png', quality: 80 }), /only supported for JPEG/);
    await assert.rejects(runner.capture({ format: 'jpeg', quality: 101 }), /Invalid quality/);
    await assert.rejects(runner.dispatch('invented'), /Unknown command/);
    await assert.rejects(runner.dispatch('android', { device: ';bad', package: 'a.b', collector: 'x.ps1' }), process.platform === 'win32' ? /Invalid device/ : /requires Windows/);
    assert.deepEqual((await runner.dispatch('list', { directory: path.join(os.tmpdir(), `absent-${Date.now()}`) })).files, []);
  } finally { await runner.dispose(); }
});

test('CLI failure is machine-readable with a nonzero exit code', async () => {
  await assert.rejects(exec(process.execPath, [cli, 'capture']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).success, false);
    return true;
  });
  await assert.rejects(exec(process.execPath, [cli, 'capture', '--unsupported']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).success, false);
    return true;
  });
});

test('one CLI batch provides MCP open/capture/close/list equivalents without a server', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-mcp-batch-'));
  const fixture = path.join(directory, 'fixture.html');
  await fs.writeFile(fixture, '<title>Batch fixture</title><main>Collection preview</main>');
  const batch = path.join(directory, 'batch.json');
  await fs.writeFile(batch, JSON.stringify([
    { tool: 'open_browser', input: { url: pathToFileURL(fixture).href, width: 320, height: 480 } },
    { tool: 'capture_screenshot', input: { selector: 'main', output: path.join(directory, 'collection.png') } },
    { tool: 'close_browser' },
    { tool: 'list_screenshots', input: { directory } },
  ]));
  const { stdout } = await exec(process.execPath, [cli, 'batch', '--file', batch]);
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.equal(result.results.length, 4);
  assert.equal(result.results[3].files.length, 1);
});
