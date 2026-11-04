/*
  The dashboard: what it reads out of the store, what it writes, and what a
  person sees when they open it.

  The browser half exists because the first version passed every unit check and
  still rendered "[object HTMLElement]" down the side peek — a page assembled in
  the browser has to be looked at in one. It also holds the page to the standard
  ayna holds everyone else to: its own audit must come back clean.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb, appendEvent } from '../src/db.mjs';
import { openStore } from '../src/tasks.mjs';
import { gatherDashboard, renderDashboard, writeDashboard, describeEvent, attentionFor, pageOf, assetUrl } from '../src/dashboard.mjs';
import { tempDir, hasBrowser } from './helpers.mjs';

const exec = promisify(execFile);
const BIN = path.resolve(fileURLToPath(new URL('../bin/ayna.mjs', import.meta.url)));

// A real 1×1 PNG, so a crop is a loadable image rather than a broken one.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A project whose store has one task in most of the states a task can be in. */
async function seeded(dir) {
  const db = await openDb(dir);
  const store = await openStore(dir, { db });
  const crop = path.join(dir, 'crop.png');
  await writeFile(crop, PNG);

  const make = async (comment, url, steps = [], extra = {}) => {
    const t = await store.create({ comment, url, selector: '.x', ...extra }, { regionScreenshot: crop });
    for (const status of steps) await store.update(t.id, { status }, status === 'rejected' ? 'still broken' : undefined);
    return t.id;
  };

  const ids = {
    open: await make('Price and unit sit on different baselines', 'http://localhost:3000/pricing'),
    applied: await make('Make the sign-up button the obvious next step', 'http://localhost:3000/', ['in_progress', 'applied']),
    proposed: await make('lowContrast: eyebrow is 3.1:1', 'http://localhost:3000/', [], { status: 'proposed', kind: 'proposal' }),
    rejected: await make('Badge overlaps the plan title', 'http://localhost:3000/pricing', [
      'in_progress', 'applied', 'rejected', 'in_progress', 'applied', 'rejected',
    ]),
    stuck: await make('Featured plan needs more separation', 'http://localhost:3000/pricing', ['in_progress']),
    approved: await make('Footer links are 11px', 'http://localhost:3000/#faq', ['in_progress', 'applied', 'approved']),
    obsolete: await make('smallTargets: icon links are 32px', 'http://localhost:3000/', ['obsolete']),
  };
  // A claim whose lease ran out: in progress on paper, abandoned in fact.
  await store.claim(ids.stuck, 'claude-session-1', { leaseMs: -60_000 });

  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, tool, pid, project, started_at, heartbeat_at, ended_at, status) VALUES (?,?,?,?,?,?,?,?)',
  ).run('claude-session-1', 'claude', 1, dir, now - 7_200_000, now - 3_600_000, null, 'dead');
  appendEvent(db, { event: 'message', from: 'user', text: 'can the badge sit inside the card?' });

  return { db, store, ids };
}

describe('dashboard: what it reads', () => {
  let tmp;
  let data;
  let ids;
  before(async () => {
    tmp = await tempDir('ayna-dash-');
    const s = await seeded(tmp.dir);
    ids = s.ids;
    data = await gatherDashboard(tmp.dir, { db: s.db });
  });
  after(() => tmp.dispose());

  test('counts every state, and what is still owed', () => {
    assert.equal(data.counts.total, 7);
    assert.equal(data.counts.pending, 5, 'approved and obsolete are the only settled states');
    assert.equal(data.counts.waiting, 2, 'proposed + applied wait on the user');
    assert.equal(data.counts.done, 2);
    assert.equal(data.counts.in_progress, 1);
  });

  test('needs attention is ranked by who is blocked, and leaves healthy work out', () => {
    assert.deepEqual(
      data.attention.map((a) => a.id),
      [ids.applied, ids.rejected, ids.stuck, ids.proposed],
    );
    assert.match(data.attention.find((a) => a.id === ids.stuck).why, /claim expired/);
    assert.ok(!data.attention.some((a) => a.id === ids.open), 'an open task with nobody stuck is not an alarm');
  });

  test('a task with a live claim is not stuck', () => {
    const later = Date.now() + 60_000;
    assert.equal(attentionFor({ status: 'in_progress', claimedBy: 'x', claimExpiresAt: later }), null);
    assert.ok(attentionFor({ status: 'in_progress', claimedBy: null }));
  });

  test('pages group by path, so a #hash is the same page', () => {
    const labels = data.pages.map((p) => p.label);
    assert.deepEqual(labels, ['/pricing', '/'], 'worst page first');
    assert.equal(data.pages.find((p) => p.label === '/').total, 4, 'the /#faq task belongs to /');
  });

  test('sent back counts rejections from the history', () => {
    assert.deepEqual(data.sentBack, [{ id: ids.rejected, rejected: 2, applied: 2 }]);
  });

  test('agents include sessions that are gone, with what they claimed', () => {
    const s = data.agents.find((a) => a.id === 'claude-session-1');
    assert.equal(s.state, 'dead');
    assert.equal(s.claims, 1);
  });

  test('the feed is newest first and reads as sentences', () => {
    assert.equal(data.activity[0].text, 'You wrote');
    assert.ok(data.activity.every((e, i, all) => i === 0 || all[i - 1].seq > e.seq));
  });
});

describe('dashboard: the page it writes', () => {
  test('user text cannot break out of the page', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      const store = await openStore(tmp.dir);
      const evil = '</script><img src=x onerror=alert(1)>';
      await store.create({ comment: evil, url: 'http://localhost:3000/', selector: '<b>' });
      const outDir = path.join(tmp.dir, '.ayna', 'dashboard');
      const html = renderDashboard(await gatherDashboard(tmp.dir), { outDir });

      assert.ok(!html.includes('<img src=x'), 'markup in a comment is escaped, never rendered');
      assert.equal(html.split('</script>').length - 1, 2, 'only the two real script blocks end');
      assert.ok(html.includes('\\u003c/script>'), 'the embedded JSON escapes `<`');
    } finally {
      await tmp.dispose();
    }
  });

  test('an empty project renders, and says how to fill it', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      const { file, data } = await writeDashboard(tmp.dir);
      assert.equal(data.counts.total, 0);
      const html = await readFile(file, 'utf8');
      assert.match(html, /No tasks yet/);
      assert.match(html, /Nothing is stuck/);
    } finally {
      await tmp.dispose();
    }
  });

  test('crops are linked relative to the page, with forward slashes', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      await seeded(tmp.dir);
      const { file } = await writeDashboard(tmp.dir);
      const html = await readFile(file, 'utf8');
      assert.ok(html.includes('src="../tasks/task-0001/region.png"'), 'a crop resolves from .ayna/dashboard/');
      assert.equal(assetUrl(path.join('/p', 'my shots', 'a.png'), '/p/out'), '../my%20shots/a.png');
    } finally {
      await tmp.dispose();
    }
  });

  test('every event reads as something, including ones it does not know', () => {
    assert.equal(describeEvent({ event: 'some-new-thing' }).text, 'some new thing');
    assert.equal(describeEvent({ event: 'task', taskId: 'task-0002', status: 'approved' }).text, 'task-0002 moved to Approved');
    assert.equal(describeEvent({ event: 'gate', clean: true }).tone, 'green');
    assert.equal(pageOf(null).label, 'No page recorded');
  });

  test('`ayna dashboard` works in a project with no config', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      await seeded(tmp.dir);
      const { stdout } = await exec('node', [BIN, 'dashboard', '--json'], { cwd: tmp.dir, timeout: 60_000 });
      const out = JSON.parse(stdout);
      assert.ok(existsSync(out.file), 'the page is written');
      assert.equal(path.dirname(out.file), path.join(tmp.dir, '.ayna', 'dashboard'), 'into the project, not the plugin');
      assert.equal(out.counts.total, 7);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('dashboard: in a browser', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let tmp;
  let browser;
  let url;
  before(async () => {
    const { openBrowser } = await import('../src/browser.mjs');
    tmp = await tempDir('ayna-dash-');
    await seeded(tmp.dir);
    const { file } = await writeDashboard(tmp.dir);
    url = pathToFileURL(file).href;
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
    await tmp?.dispose();
  });

  test('passes ayna’s own audit, on a desktop and on a phone', async () => {
    const { auditPage } = await import('../src/audit.mjs');
    const report = await auditPage({
      browser,
      url,
      viewports: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ],
      outDir: path.join(tmp.dir, 'audit'),
    });
    assert.equal(report.unmeasured.length, 0, 'the audit actually ran');
    for (const [kind, n] of Object.entries(report.counts)) assert.equal(n, 0, `${kind}: ${n}`);
  });

  test('opening a task shows its properties, not object names', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(url);
      await page.click('#tasks [data-open="task-0004"]');
      const peek = page.locator('#peek');
      await peek.waitFor({ state: 'visible' });
      const text = await peek.innerText();
      assert.match(text, /Badge overlaps the plan title/);
      assert.match(text, /Status\s+Rejected/);
      assert.match(text, /History/);
      assert.doesNotMatch(text, /\[object/, 'nested children are flattened into the page');
      assert.doesNotMatch(text, /(^|\n)null(\n|$)/, 'an absent section is left out, not written as "null"');

      await page.keyboard.press('Escape');
      await peek.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('the views and filters only change what is shown', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await page.click('[data-filter="1"]');
      const rows = page.locator('[data-pane="table"] [data-task]:visible');
      assert.equal(await rows.count(), 2, 'Done shows the approved and obsolete tasks');

      await page.click('[data-view="gallery"]');
      assert.equal(await page.locator('[data-pane="gallery"] .card:visible').count(), 2);
      assert.ok(await page.locator('[data-pane="table"]').isHidden());

      await page.click('[data-filter="all"]');
      assert.equal(await page.locator('[data-pane="gallery"] .card:visible').count(), 7);
    } finally {
      await page.close();
    }
  });
});
