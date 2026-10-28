#!/usr/bin/env node
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { SOURCES, getSource } from './sources/index.js';
import { download, searchLibrary, libraryStats } from './library.js';

const runFile = promisify(execFile);
type Input = Record<string, unknown>;
const outputRoot = () => path.resolve(process.env.SCREENSHOT_OUTPUT_DIR ?? './screenshots');

function integer(value: unknown, fallback: number, name: string, min = 1, max = 10000): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}

function urlOf(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A URL is required');
  const url = new URL(value);
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('Use an HTTP(S) or local file URL');
  return url.href;
}

async function vacant(filename: string): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  try { await fs.access(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite ${filename}`);
}

async function evidence(filename: string, extra: Input): Promise<Input> {
  const bytes = await fs.readFile(filename);
  const result = { success: true, path: filename, timestamp: new Date().toISOString(),
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...extra };
  await fs.writeFile(`${filename}.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

/** Sessions live within one batch invocation; no MCP transport or background daemon. */
export class ScreenshotRunner {
  private sessions = new Map<string, { browser: Browser; page: Page }>();

  async open(input: Input): Promise<Input> {
    const url = urlOf(input.url);
    const engine = String(input.browser ?? 'chromium');
    if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('Invalid browser');
    const width = integer(input.width, 1280, 'width');
    const height = integer(input.height, 720, 'height');
    const timeout = integer(input.timeout, 30000, 'timeout', 1, 120000);
    const playwright = await import('playwright');
    const browser = await playwright[engine as 'chromium' | 'firefox' | 'webkit'].launch();
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      page.setDefaultTimeout(timeout);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()} at ${page.url()}`);
      const sessionId = `session-${randomUUID()}`;
      this.sessions.set(sessionId, { browser, page });
      return { success: true, sessionId, path: sessionId, url: page.url(), title: await page.title() };
    } catch (error) { await browser.close(); throw error; }
  }

  private session(input: Input) {
    const id = input.sessionId === undefined ? [...this.sessions.keys()].at(-1) : String(input.sessionId);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) throw new Error('No active session. Supply a URL or use open_browser in a batch first.');
    return { id: id!, ...session };
  }

  async capture(input: Input): Promise<Input> {
    const format = String(input.format ?? 'png');
    if (!['png', 'jpeg'].includes(format)) throw new Error('Format must be png or jpeg');
    if (input.quality !== undefined && format !== 'jpeg') throw new Error('Quality is only supported for JPEG');
    const quality = input.quality === undefined ? undefined : integer(input.quality, 80, 'quality', 0, 100);
    const opened = input.url ? await this.open(input) : undefined;
    const { page } = this.session(opened ? { sessionId: opened.sessionId } : input);
    if (input.width !== undefined || input.height !== undefined) {
      await page.setViewportSize({ width: integer(input.width, page.viewportSize()!.width, 'width'),
        height: integer(input.height, page.viewportSize()!.height, 'height') });
    }
    if (input.waitFor) await page.locator(String(input.waitFor)).waitFor({ state: 'visible' });
    if (input.expectText && !(await page.locator('body').innerText()).includes(String(input.expectText))) {
      throw new Error(`Expected text not visible: ${input.expectText}. A login/error page is not reference proof.`);
    }
    // Explicitly wait for fonts and currently loaded images, not endless analytics network activity.
    await page.waitForFunction(() => [...document.images]
      .filter(img => img.loading !== 'lazy').every(img => img.complete) && document.fonts.status === 'loaded',
      undefined, { timeout: 10000 });
    const filename = path.resolve(String(input.output ?? path.join(outputRoot(), `screenshot-${randomUUID()}.${format}`)));
    if (!filename.toLowerCase().endsWith(format === 'jpeg' ? '.jpg' : '.png') &&
        !(format === 'jpeg' && filename.toLowerCase().endsWith('.jpeg'))) throw new Error('Output extension does not match format');
    await vacant(filename);
    await vacant(`${filename}.json`);
    const options = { path: filename, type: format as 'png' | 'jpeg', quality, animations: 'disabled' as const };
    const bytes = input.selector
      ? await page.locator(String(input.selector)).screenshot(options)
      : await page.screenshot({ ...options, fullPage: input.fullPage === true });
    // PNG header gives actual dimensions, including element/full-page captures.
    const size = format === 'png' ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : undefined;
    return evidence(filename, { kind: 'web', url: page.url(), requestedUrl: input.url,
      title: await page.title(), selector: input.selector, format, size, viewport: page.viewportSize() });
  }

  async dispatch(tool: string, input: Input = {}): Promise<Input> {
    switch (tool) {
      case 'capture': case 'capture_screenshot': return this.capture(input);
      case 'open_browser': return this.open(input);
      case 'navigate': {
        const { page } = this.session(input);
        const response = await page.goto(urlOf(input.url), { waitUntil: 'domcontentloaded' });
        if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
        return { success: true, url: page.url(), title: await page.title() };
      }
      case 'close_browser': {
        const { id, browser } = this.session(input);
        await browser.close(); this.sessions.delete(id);
        return { success: true, sessionId: id };
      }
      case 'list': case 'list_screenshots': {
        const directory = path.resolve(String(input.directory ?? outputRoot()));
        const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []; throw error;
        });
        const files = [];
        for (const name of names.filter(name => /\.(png|jpe?g)$/i.test(name)).sort()) {
          const filename = path.join(directory, name);
          const stats = await fs.stat(filename);
          if (stats.isFile()) files.push({ name, path: filename, bytes: stats.size, modified: stats.mtime.toISOString() });
        }
        return { success: true, directory, files };
      }
      case 'android': return captureAndroid(input);
      default: throw new Error(`Unknown command: ${tool}`);
    }
  }

  async dispose() {
    await Promise.all([...this.sessions.values()].map(session => session.browser.close()));
    this.sessions.clear();
  }
}

async function captureAndroid(input: Input): Promise<Input> {
  if (process.platform !== 'win32') throw new Error('The Android evidence collector runs through PowerShell and requires Windows');
  const device = String(input.device ?? 'emulator-5554');
  if (!input.package) throw new Error('android requires --package (the app id to verify as foreground)');
  const pkg = String(input.package);
  const collectorPath = input.collector ?? process.env.ANDROID_COLLECTOR_SCRIPT;
  if (!collectorPath) throw new Error('android requires --collector PATH or ANDROID_COLLECTOR_SCRIPT (a PowerShell script taking -DeviceId -Package -OutDir)');
  const collector = path.resolve(String(collectorPath));
  if (!/^[\w.:-]+$/.test(device) || !/^[\w.]+$/.test(pkg)) throw new Error('Invalid device/package');
  await fs.access(collector);
  const root = path.resolve(String(input.directory ?? outputRoot()));
  const directory = path.join(root, `android-${randomUUID()}`);
  const { stdout, stderr } = await runFile('powershell.exe', ['-NoProfile', '-File', collector,
    '-DeviceId', device, '-Package', pkg, '-OutDir', directory], { timeout: 60000, windowsHide: true });
  const names = await fs.readdir(directory);
  const screenshot = names.find(name => name.endsWith('-screenshot.png'));
  if (!screenshot) throw new Error(`Android collector produced no screenshot: ${stderr || stdout}`);
  const stamp = screenshot.replace('-screenshot.png', '');
  const suffixes = ['screenshot.png', 'ui-hierarchy.xml', 'logcat-tail.txt', 'package.txt', 'activity.txt', 'getprop.txt', 'devices.txt'];
  const files: Record<string, string> = {};
  for (const suffix of suffixes) {
    const filename = path.join(directory, `${stamp}-${suffix}`);
    if ((await fs.stat(filename)).size === 0) throw new Error(`Empty evidence: ${filename}`);
    files[suffix] = filename;
  }
  const bytes = await fs.readFile(files['screenshot.png']);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid Android PNG');
  const xml = await fs.readFile(files['ui-hierarchy.xml'], 'utf8');
  if (!xml.includes('<hierarchy')) throw new Error('Android UI hierarchy is missing');
  const activity = await fs.readFile(files['activity.txt'], 'utf8');
  const resumed = activity.split('\n').filter(line => /(?:mResumedActivity|topResumedActivity|ResumedActivity):/.test(line));
  if (!resumed.some(line => line.includes(`${pkg}/`))) throw new Error(`${pkg} is not the foreground app`);
  const escapedPackage = pkg.replace(/\./g, '\\.');
  if (!(await fs.readFile(files['package.txt'], 'utf8')).match(new RegExp(`Package \\[${escapedPackage}\\]`))) {
    throw new Error('Package dump does not identify the requested app');
  }
  return evidence(files['screenshot.png'], { kind: 'android', device, package: pkg, files, format: 'png',
    size: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } });
}

async function libraryCommand(command: string, v: Record<string, any>, page: number): Promise<unknown> {
  const need = (k: string) => { if (!v[k]) throw new Error(`${command} requires --${k}`); return String(v[k]); };
  switch (command) {
    case 'sources':
      if (!v.check) return Object.values(SOURCES).map(s => ({ id: s.id, description: s.description }));
      return Promise.all(Object.values(SOURCES).map(s => s.search(s.id === 'dribbble' ? 'onboarding' : 'instagram', 1)
        .then(r => ({ id: s.id, ok: r.items.length > 0, results: r.items.length }), e => ({ id: s.id, ok: false, error: String(e) }))));
    case 'search': return getSource(need('source')).search(need('query'), page);
    case 'screens': return getSource(need('source')).screens(need('app'), page);
    case 'sync':
      return download({ source: need('source'), appId: v.app, query: v.query,
        limit: v.limit === undefined ? undefined : integer(v.limit, 1, 'limit', 1, 1000000),
        onProgress: (n, item, status) => console.error(`${n} ${status} ${item.source}/${item.app ?? ''}/${item.id}`) });
    case 'library': return v.query ? searchLibrary(v.query, integer(v.limit, 50, 'limit')) : libraryStats();
  }
  return undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const runner = new ScreenshotRunner();
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      url: { type: 'string' }, selector: { type: 'string' }, browser: { type: 'string' },
      width: { type: 'string' }, height: { type: 'string' }, format: { type: 'string' }, quality: { type: 'string' },
      output: { type: 'string' }, directory: { type: 'string' }, timeout: { type: 'string' },
      device: { type: 'string' }, package: { type: 'string' }, collector: { type: 'string' }, file: { type: 'string' },
      'full-page': { type: 'boolean' }, 'wait-for': { type: 'string' }, 'expect-text': { type: 'string' },
      source: { type: 'string' }, query: { type: 'string' }, app: { type: 'string' }, page: { type: 'string' },
      limit: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help || !positionals.length) {
      console.log('Screenshot CLI (no MCP server)\n' +
        'capture --url URL [--selector CSS] [--full-page] [--browser chromium|firefox|webkit]\n' +
        '        [--width N --height N] [--format png|jpeg --quality N] [--output FILE]\n' +
        '        [--wait-for CSS] [--expect-text TEXT] [--timeout MS]\n' +
        'android --package APP_ID --collector SCRIPT.ps1 [--device emulator-5554] [--directory DIR]\n' +
        'sources [--check]\n' +
        'search --source SOURCE --query TEXT [--page N]\n' +
        'screens --source SOURCE --app APP_ID [--page N]\n' +
        'sync --source SOURCE (--app APP_ID | --query TEXT) [--limit N]  (into UI_LIBRARY_DIR, default ~/.ui-library)\n' +
        'library [--query TEXT] [--limit N]\n' +
        'list [--directory DIR]\nbatch --file FILE (JSON array of {tool, input}; sessions last for this batch)');
      return;
    }
    if (positionals.length !== 1) throw new Error('Supply exactly one command');
    const input = { ...values, fullPage: values['full-page'], waitFor: values['wait-for'], expectText: values['expect-text'] };
    const library = await libraryCommand(positionals[0], values, integer(values.page, 1, 'page'));
    if (library !== undefined) console.log(JSON.stringify(library, null, 2));
    else if (positionals[0] === 'batch') {
      if (!values.file) throw new Error('batch requires --file');
      const steps = JSON.parse(await fs.readFile(values.file, 'utf8'));
      if (!Array.isArray(steps)) throw new Error('Batch file must be a JSON array');
      const results = [];
      for (const step of steps) results.push(await runner.dispatch(step.tool, step.input));
      console.log(JSON.stringify({ success: true, results }, null, 2));
    } else console.log(JSON.stringify(await runner.dispatch(positionals[0], input), null, 2));
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally { await runner.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
