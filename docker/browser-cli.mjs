#!/usr/bin/env node
/**
 * browser-cli.mjs — Thin CLI wrapper around Playwright for agentic use.
 *
 * Keeps Chromium alive between invocations via CDP.
 * State file at /tmp/.browser-cli.json stores the CDP endpoint.
 *
 * Usage: node /usr/local/lib/browser-cli.mjs '{"action":"open","url":"https://example.com"}'
 */

import { createRequire } from 'module';
const require = createRequire('/usr/lib/node_modules/');
const { chromium } = require('playwright');

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { execSync, spawn } from 'child_process';

const STATE_FILE = '/tmp/.browser-cli.json';
const CDP_PORT = 9222;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 720 };

// ── State persistence ──

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch { /* corrupt state */ }
  return null;
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
}

function clearState() {
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
}

// ── Launch or connect to Chromium ──

async function ensureBrowser() {
  const state = loadState();

  // Try reconnecting to existing browser
  if (state?.cdpUrl) {
    try {
      const browser = await chromium.connectOverCDP(state.cdpUrl, { timeout: 3000 });
      const contexts = browser.contexts();
      const ctx = contexts[0] || await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT });
      const pages = ctx.pages();
      const page = pages[0] || await ctx.newPage();
      return { browser, page };
    } catch {
      // Browser died — clean up and launch fresh
      clearState();
    }
  }

  // Launch Chromium with remote debugging
  const chromePath = chromium.executablePath();
  const child = spawn(chromePath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-agent=${USER_AGENT}`,
    `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
  ], { stdio: 'ignore', detached: true });
  child.unref();

  // Wait for CDP to be ready
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${cdpUrl}/json/version`);
      if (resp.ok) break;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0] || await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT });
  const page = ctx.pages()[0] || await ctx.newPage();

  saveState({ cdpUrl });
  return { browser, page };
}

// ── Actions ──

async function handleAction(input) {
  const { action } = input;

  if (action === 'close') {
    try { execSync('pkill -f "chrome.*remote-debugging"', { stdio: 'ignore' }); } catch { /* ok */ }
    clearState();
    return 'Browser closed.';
  }

  const { browser, page } = await ensureBrowser();

  try {
    switch (action) {
      case 'open': {
        if (!input.url) return 'Error: "url" is required.';
        const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const status = response?.status() ?? 'unknown';
        const title = await page.title();
        return `Navigated to ${input.url}\nTitle: ${title}\nStatus: ${status}`;
      }

      case 'snapshot': {
        const url = page.url();
        const title = await page.title();

        // Use CDP to get the accessibility tree
        const cdp = await page.context().newCDPSession(page);
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        await cdp.detach();

        const tree = formatAXNodes(nodes);
        return `URL: ${url}\nTitle: ${title}\n\n${tree}`;
      }

      case 'click': {
        if (!input.selector) return 'Error: "selector" is required.';
        await page.click(input.selector, { timeout: 5000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return `Clicked: ${input.selector}`;
      }

      case 'type': {
        if (!input.selector) return 'Error: "selector" is required.';
        if (input.text === undefined) return 'Error: "text" is required.';
        await page.fill(input.selector, input.text, { timeout: 5000 });
        return `Typed into ${input.selector}: "${input.text}"`;
      }

      case 'select': {
        if (!input.selector) return 'Error: "selector" is required.';
        if (!input.values?.length) return 'Error: "values" is required.';
        await page.selectOption(input.selector, input.values, { timeout: 5000 });
        return `Selected ${input.values.join(', ')} in ${input.selector}`;
      }

      case 'hover': {
        if (!input.selector) return 'Error: "selector" is required.';
        await page.hover(input.selector, { timeout: 5000 });
        return `Hovered: ${input.selector}`;
      }

      case 'screenshot': {
        const buffer = await page.screenshot({ fullPage: false });
        const title = await page.title();
        const url = page.url();
        return JSON.stringify({
          __type: 'screenshot',
          text: `Screenshot of "${title}" (${url})\nViewport: 1280x720, ${buffer.length} bytes`,
          base64: buffer.toString('base64'),
          mediaType: 'image/png',
        });
      }

      case 'scroll': {
        const delta = input.direction === 'up' ? -(input.amount ?? 300) : (input.amount ?? 300);
        await page.mouse.wheel(0, delta);
        await new Promise(r => setTimeout(r, 300));
        return `Scrolled ${input.direction ?? 'down'} by ${Math.abs(delta)}px`;
      }

      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return `Navigated back to: ${page.url()}`;
      }

      case 'forward': {
        await page.goForward({ waitUntil: 'domcontentloaded' });
        return `Navigated forward to: ${page.url()}`;
      }

      case 'wait': {
        const ms = input.ms ?? 1000;
        await new Promise(r => setTimeout(r, ms));
        return `Waited ${ms}ms`;
      }

      case 'evaluate': {
        if (!input.expression) return 'Error: "expression" is required.';
        const result = await page.evaluate(input.expression);
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? 'undefined';
      }

      case 'press': {
        if (!input.key) return 'Error: "key" is required.';
        if (input.selector) {
          await page.press(input.selector, input.key, { timeout: 5000 });
        } else {
          await page.keyboard.press(input.key);
        }
        return `Pressed: ${input.key}${input.selector ? ` on ${input.selector}` : ''}`;
      }

      case 'upload': {
        if (!input.selector) return 'Error: "selector" is required.';
        if (!input.files?.length) return 'Error: "files" is required (array of paths).';
        await page.setInputFiles(input.selector, input.files, { timeout: 5000 });
        return `Uploaded ${input.files.length} file(s) to ${input.selector}: ${input.files.join(', ')}`;
      }

      default:
        return `Error: Unknown action "${action}"`;
    }
  } finally {
    // Disconnect CDP but leave Chromium running
    browser.close().catch(() => {});
  }
}

// ── Snapshot formatting (CDP AX tree) ──

function formatAXNodes(nodes) {
  if (!nodes?.length) return '(empty page)';

  // Build parent→children map
  const childMap = new Map();
  const nodeMap = new Map();
  for (const n of nodes) {
    nodeMap.set(n.nodeId, n);
    if (n.childIds) {
      childMap.set(n.nodeId, n.childIds);
    }
  }

  function prop(n, name) {
    return n.properties?.find(p => p.name === name)?.value?.value;
  }

  function render(nodeId, depth) {
    const n = nodeMap.get(nodeId);
    if (!n) return '';
    const role = n.role?.value || '';
    const name = n.name?.value || '';
    const value = n.value?.value;
    const children = childMap.get(nodeId) || [];

    // Skip noise — inline text, generics, and leaf StaticText (parent already has the name)
    const skip = ['none', 'generic', 'InlineTextBox', 'LineBreak'].includes(role)
      || (role === 'StaticText' && children.length === 0);
    const lines = [];
    const indent = '  '.repeat(depth);

    if (!skip && role) {
      const parts = [role];
      if (name) parts.push(`"${name}"`);
      if (value) parts.push(`value="${value}"`);
      const checked = prop(n, 'checked');
      if (checked) parts.push(`checked=${checked}`);
      const expanded = prop(n, 'expanded');
      if (expanded !== undefined) parts.push(`expanded=${expanded}`);
      lines.push(`${indent}${parts.join(' ')}`);
    }

    for (const cid of children) {
      const sub = render(cid, skip ? depth : depth + 1);
      if (sub) lines.push(sub);
    }
    return lines.join('\n');
  }

  // Root is typically nodeId of first node
  return render(nodes[0].nodeId, 0);
}

// ── Main ──

try {
  const input = JSON.parse(process.argv[2] || '{}');
  const result = await handleAction(input);
  process.stdout.write(result);
} catch (err) {
  process.stderr.write(`Browser error: ${err.message}\n`);
  process.exit(1);
}
