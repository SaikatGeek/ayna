import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openDb, eventsSince, latestSeq } from './db.mjs';
import { openStore, isPending, STATUSES } from './tasks.mjs';
import { STALE_AFTER } from './sessions.mjs';

/**
 * Everything the store knows, as one page somebody can read.
 *
 * The database already holds the whole story — every comment, every status a
 * task moved through, who claimed what, what the window and the agents said to
 * each other — and the only ways to see it were a terminal list, raw JSON, or a
 * task panel that shows the page currently open and forgets it when the window
 * closes. None of those answer the questions a person actually has after a few
 * days of reviews: what is still owed, what is stuck, which page is worst, what
 * keeps being sent back.
 *
 * It is a static file, not a server. It reads the store, writes one HTML page
 * with its styles and script inline, and is done — so it opens from disk, works
 * offline, adds no dependency, and cannot change a task. Running it again is how
 * it refreshes.
 */

/** How each status reads on the page. Tones are a light tag palette. */
export const STATUS = {
  proposed: { label: 'Proposed', tone: 'purple', hint: 'Found by a tool — waiting for your go-ahead' },
  open: { label: 'Open', tone: 'gray', hint: 'Waiting to be worked on' },
  in_progress: { label: 'In progress', tone: 'blue', hint: 'An agent is working on it' },
  applied: { label: 'Applied', tone: 'yellow', hint: 'Changed — waiting for your review' },
  needs_confirmation: { label: 'Needs confirmation', tone: 'orange', hint: 'verify could not settle it — it needs your word' },
  rejected: { label: 'Rejected', tone: 'red', hint: 'Sent back for another attempt' },
  approved: { label: 'Approved', tone: 'green', hint: 'You accepted the change' },
  obsolete: { label: 'Obsolete', tone: 'brown', hint: 'verify found the fault gone' },
};

const labelOf = (s) => STATUS[s]?.label ?? String(s ?? 'unknown');
const toneOf = (s) => STATUS[s]?.tone ?? 'gray';
const hintOf = (s) => STATUS[s]?.hint ?? '';

/** Where a task lives, in a form that groups: one row per page, not per hash. */
export function pageOf(url) {
  if (!url) return { key: '', label: 'No page recorded', host: null };
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}` || '/';
    return { key: `${u.origin}${p}`, label: p, host: u.host };
  } catch {
    return { key: url, label: url, host: null };
  }
}

/**
 * Why a task needs a person, or null when it does not.
 *
 * Ranked by who is blocked: something applied or unsettled is waiting on the
 * user's eye right now, a rejection is waiting on an agent, and a proposal is
 * only a suggestion. A task in progress is fine while somebody holds a live
 * claim on it, and stuck the moment nobody does.
 */
export function attentionFor(task, now = Date.now()) {
  switch (task.status) {
    case 'needs_confirmation':
      return { rank: 0, why: 'verify could not settle it — it needs your word' };
    case 'applied':
      return { rank: 1, why: 'changed, and waiting for your review' };
    case 'rejected':
      return { rank: 2, why: 'sent back — waiting for another attempt' };
    case 'in_progress':
      if (!task.claimedBy) return { rank: 3, why: 'marked in progress, but nobody holds it' };
      if (task.claimExpiresAt && task.claimExpiresAt < now) {
        return { rank: 3, why: 'its claim expired — nobody is working on it' };
      }
      return null;
    case 'proposed':
      return { rank: 4, why: 'found by a tool — waiting for your go-ahead' };
    default:
      return null;
  }
}

const quote = (s, n = 140) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

const short = (id) => {
  const s = String(id ?? '');
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
};

/** One line of the activity feed: what happened, and the detail under it. */
export function describeEvent(e) {
  const id = e.taskId ?? e.id ?? '';
  const tone = (t) => t;
  switch (e.event) {
    case 'task':
      if ('comment' in e) return { text: `New task ${id}`, detail: quote(e.comment), tone: toneOf(e.status) };
      return { text: `${id} moved to ${labelOf(e.status)}`, detail: quote(e.note), tone: toneOf(e.status) };
    case 'claimed':
      return { text: `${id} claimed`, detail: e.by ? `by ${short(e.by)}` : '', tone: 'blue' };
    case 'released':
      return { text: `${id} released`, detail: '', tone: 'gray' };
    case 'working':
      return { text: `Work started on ${id}`, detail: quote(e.comment), tone: 'blue' };
    case 'failed':
      return { text: `${id} failed`, detail: quote(e.why), tone: 'red' };
    case 'skipped':
      return { text: `${id} skipped`, detail: quote(e.why), tone: 'gray' };
    case 'applied':
      if (id) return { text: `${id} applied`, detail: quote(e.note), tone: 'yellow' };
      return { text: e.round ? `Edits applied for round ${e.round}` : 'Edits applied', detail: '', tone: 'yellow' };
    case 'gate':
      if (e.unavailable) return { text: 'Gate could not measure the page', detail: quote(e.unavailable), tone: 'orange' };
      return e.clean
        ? { text: 'Gate re-measured — no measurable faults left', detail: '', tone: 'green' }
        : { text: 'Gate re-measured — faults remain', detail: '', tone: 'orange' };
    case 'round':
      return {
        text: `Round ${e.round ?? ''} sent from the review window`.replace('  ', ' '),
        detail: e.comments != null ? `${e.comments} comment${e.comments === 1 ? '' : 's'}` : '',
        tone: 'blue',
      };
    case 'rejected':
      return { text: 'A change was sent back', detail: quote(e.comment), tone: 'red' };
    case 'message': {
      const who = e.from === 'user' ? 'You' : e.from ? e.from[0].toUpperCase() + e.from.slice(1) : 'Agent';
      return { text: `${who} wrote`, detail: quote(e.text, 220), tone: e.from === 'user' ? 'purple' : 'blue' };
    }
    case 'closed':
      return { text: e.approved ? 'Review approved and closed' : 'Review window closed', detail: '', tone: e.approved ? 'green' : 'gray' };
    case 'audit':
      return { text: e.clean ? 'Audit found nothing measurable' : 'Audit found faults', detail: quote(e.url), tone: e.clean ? 'green' : 'orange' };
    case 'preview': {
      const n = Array.isArray(e.variants) ? e.variants.length : 0;
      const sel = Array.isArray(e.selector) ? e.selector.join(', ') : e.selector;
      return { text: `Previewed ${n || 'some'} variant${n === 1 ? '' : 's'}`, detail: quote(sel), tone: 'purple' };
    }
    case 'preview-timeout':
      return { text: 'A preview went unanswered', detail: '', tone: 'gray' };
    case 'edits':
      return { text: 'Source files changed', detail: '', tone: 'gray' };
    case 'tab-opened':
      return { text: 'Review window opened', detail: quote(e.url), tone: 'gray' };
    case 'tab-closed':
      return { text: 'Review window closed', detail: '', tone: 'gray' };
    case 'tab-claimed':
      return { text: 'Review window handed to another session', detail: '', tone: 'gray' };
    case 'session-started':
      return { text: `${e.tool ? e.tool[0].toUpperCase() + e.tool.slice(1) : 'An agent'} session started`, detail: '', tone: 'gray' };
    case 'session-ended':
      return { text: 'Session ended', detail: '', tone: 'gray' };
    case 'session-died':
      return { text: 'Session went away without ending', detail: '', tone: 'red' };
    case 'design-request':
      return { text: 'Design review requested', detail: '', tone: 'purple' };
    case 'leases-expired':
      return { text: 'Expired claims returned to the pool', detail: '', tone: 'gray' };
    default:
      return { text: tone(String(e.event ?? 'event').replace(/[-_]/g, ' ')), detail: id ? id : '', tone: 'gray' };
  }
}

/** Everything the page shows, gathered without writing to the store. */
export async function gatherDashboard(projectDir, { db: given, now = Date.now(), activityLimit = 120 } = {}) {
  const db = given ?? (await openDb(projectDir));
  const store = await openStore(projectDir, { db });
  const tasks = await store.list();

  const counts = { total: tasks.length, pending: tasks.filter(isPending).length };
  for (const s of STATUSES) counts[s] = tasks.filter((t) => t.status === s).length;
  counts.waiting = counts.proposed + counts.applied + counts.needs_confirmation;
  counts.done = counts.approved + counts.obsolete;

  const attention = tasks
    .map((t) => ({ t, a: attentionFor(t, now) }))
    .filter((x) => x.a)
    .sort((x, y) => x.a.rank - y.a.rank || Date.parse(x.t.updatedAt) - Date.parse(y.t.updatedAt))
    .map(({ t, a }) => ({ id: t.id, why: a.why }));

  // Pages, worst first. The host is only shown when there is more than one,
  // because "localhost:3000" on every row is noise.
  const groups = new Map();
  for (const t of tasks) {
    const p = pageOf(t.url);
    const g = groups.get(p.key) ?? { ...p, total: 0, pending: 0, done: 0, byStatus: {} };
    g.total += 1;
    if (isPending(t)) g.pending += 1;
    else g.done += 1;
    g.byStatus[t.status] = (g.byStatus[t.status] ?? 0) + 1;
    groups.set(p.key, g);
  }
  const hosts = new Set([...groups.values()].map((g) => g.host).filter(Boolean));
  const pages = [...groups.values()]
    .map((g) => ({ ...g, label: hosts.size > 1 && g.host ? `${g.host}${g.label}` : g.label }))
    .sort((a, b) => b.pending - a.pending || b.total - a.total || a.label.localeCompare(b.label));

  // Sent back: a rejection is the one signal that a fix did not take.
  const sentBack = tasks
    .map((t) => ({
      id: t.id,
      rejected: t.history.filter((h) => h.status === 'rejected').length,
      applied: t.history.filter((h) => h.status === 'applied').length,
    }))
    .filter((x) => x.rejected > 0)
    .sort((a, b) => b.rejected - a.rejected || b.applied - a.applied);

  // The newest events. Pruning removes the oldest, so the tail is contiguous.
  const latest = latestSeq(db);
  const activity = eventsSince(db, Math.max(0, latest - activityLimit), activityLimit)
    .reverse()
    .map((e) => ({ seq: e.seq, at: e.at, event: e.event, taskId: e.taskId ?? null, ...describeEvent(e) }));

  // Every session the project has seen, not only the live ones `ayna agents`
  // shows: a session that died holding a claim is exactly the one worth seeing.
  const claims = {};
  try {
    const rows = db
      .prepare("SELECT json_extract(payload, '$.by') AS who, COUNT(*) AS n FROM events WHERE event = 'claimed' GROUP BY who")
      .all();
    for (const r of rows) if (r.who) claims[r.who] = r.n;
  } catch {
    // No JSON functions in this SQLite build: claims stay uncounted, not wrong.
  }
  const agents = db
    .prepare('SELECT * FROM sessions ORDER BY heartbeat_at DESC LIMIT 50')
    .all()
    .map((s) => {
      const state = s.status === 'live' ? (now - s.heartbeat_at > STALE_AFTER ? 'quiet' : 'live') : s.status;
      return {
        id: s.id,
        tool: s.tool,
        agentId: s.agent_id ?? null,
        state,
        startedAt: s.started_at,
        lastSeenAt: s.ended_at ?? s.heartbeat_at,
        claims: claims[s.id] ?? 0,
        holding: tasks.filter((t) => t.claimedBy === s.id && (!t.claimExpiresAt || t.claimExpiresAt > now)).length,
      };
    });

  return {
    project: path.basename(path.resolve(projectDir)),
    generatedAt: now,
    counts,
    tasks,
    attention,
    pages,
    sentBack,
    activity,
    agents,
  };
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A path an <img> on this page can load, on any OS — Windows writes backslashes. */
export function assetUrl(file, fromDir) {
  if (!file) return null;
  return path.relative(fromDir, file).split(path.sep).map(encodeURIComponent).join('/');
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Absolute in the file, relative once the page runs: a static page cannot know "now". */
const when = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '<span class="muted">—</span>';
  return `<time datetime="${new Date(ms).toISOString()}" data-rel>${esc(DATE.format(ms))}</time>`;
};

const pill = (status) =>
  `<span class="pill t-${toneOf(status)}" title="${esc(hintOf(status))}"><span class="dot" aria-hidden="true"></span>${esc(labelOf(status))}</span>`;

const sourceLabel = (c) => {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c.line ? `${c.file}:${c.line}` : String(c.file ?? '');
};

/** The task as the side peek needs it — paths made relative, nothing it will not show. */
function forPeek(t, outDir) {
  return {
    id: t.id,
    status: t.status,
    label: labelOf(t.status),
    tone: toneOf(t.status),
    hint: hintOf(t.status),
    comment: t.comment ?? '',
    kind: t.kind ?? null,
    url: t.url ?? null,
    page: pageOf(t.url).label,
    selector: t.selector ?? null,
    sources: (t.sourceCandidates ?? []).slice(0, 5).map(sourceLabel).filter(Boolean),
    claimedBy: t.claimedBy ?? null,
    verdict: t.verdict
      ? { verdict: t.verdict.verdict ?? null, why: t.verdict.why ?? null }
      : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    crop: assetUrl(t.regionScreenshot, outDir),
    attachments: (t.attachments ?? []).map((a) => assetUrl(a, outDir)),
    history: (t.history ?? []).map((h) => ({ at: h.at, status: h.status, label: labelOf(h.status), tone: toneOf(h.status), note: h.note ?? null })),
  };
}

const section = (id, title, lede, body) => `
    <section id="${id}" aria-labelledby="${id}-h">
      <h2 id="${id}-h">${esc(title)}</h2>
      ${lede ? `<p class="lede">${lede}</p>` : ''}
      ${body}
    </section>`;

const empty = (text) => `<p class="empty">${text}</p>`;

function overview(d) {
  const c = d.counts;
  const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const present = STATUSES.filter((s) => c[s] > 0);
  const bar = c.total
    ? `<div class="bar" role="img" aria-label="${esc(present.map((s) => `${c[s]} ${labelOf(s)}`).join(', '))}">${present
        .map((s) => `<span class="t-${toneOf(s)}" style="flex:${c[s]}"></span>`)
        .join('')}</div>
      <ul class="legend">${present
        .map((s) => `<li><span class="dot t-${toneOf(s)}" aria-hidden="true"></span>${esc(labelOf(s))} <span class="n">${c[s]}</span></li>`)
        .join('')}</ul>`
    : '';
  return section(
    'overview',
    'Overview',
    '',
    `<div class="stats">
        ${stat('Outstanding', c.pending, `of ${c.total} task${c.total === 1 ? '' : 's'}`)}
        ${stat('Waiting on you', c.waiting, 'to approve, judge or allow')}
        ${stat('In progress', c.in_progress, 'claimed by an agent')}
        ${stat('Done', c.done, `${c.obsolete} closed by verify`)}
      </div>
      ${bar}`,
  );
}

function attentionList(d, byId) {
  const rows = d.attention.map(({ id, why }) => {
    const t = byId.get(id);
    return `<button type="button" class="arow" data-open="${esc(id)}">
          ${pill(t.status)}
          <span class="arow-main"><span class="strong">${esc(quote(t.comment, 110) || '(no comment)')}</span><span class="muted">${esc(id)} · ${esc(why)}</span></span>
          <span class="arow-side muted"><span class="path">${esc(pageOf(t.url).label)}</span><br>${when(t.updatedAt)}</span>
        </button>`;
  });
  return section(
    'attention',
    'Needs attention',
    'Work that is waiting on somebody — most blocked first.',
    rows.length ? `<div class="callout">${rows.join('')}</div>` : empty('Nothing is stuck. Every open task has somebody on it.'),
  );
}

function taskViews(d, outDir) {
  if (!d.tasks.length) {
    return section(
      'tasks',
      'Tasks',
      '',
      empty('No tasks yet. Run <code>ayna annotate</code> and comment on the page — every comment lands here.'),
    );
  }
  const done = (t) => (isPending(t) ? '0' : '1');
  const rows = d.tasks
    .map((t) => {
      const page = pageOf(t.url).label;
      return `<tr data-task data-done="${done(t)}">
            <td class="col-task"><button type="button" class="open" data-open="${esc(t.id)}"><span class="strong">${esc(quote(t.comment) || '(no comment)')}</span><span class="sub muted">${esc(t.id)}<span class="only-narrow"> · <span class="path">${esc(page)}</span></span></span></button></td>
            <td class="col-status">${pill(t.status)}</td>
            <td class="col-page"><span class="path">${esc(page)}</span></td>
            <td class="col-el">${t.selector ? `<code>${esc(quote(t.selector, 60))}</code>` : '<span class="muted">—</span>'}</td>
            <td class="col-upd muted">${when(t.updatedAt)}</td>
          </tr>`;
    })
    .join('');
  const cards = d.tasks
    .map((t) => {
      const crop = assetUrl(t.regionScreenshot, outDir);
      return `<button type="button" class="card" data-task data-done="${done(t)}" data-open="${esc(t.id)}">
            <span class="cover">${crop ? `<img src="${esc(crop)}" alt="The element ${esc(t.id)} is about" loading="lazy">` : `<span class="nocrop muted">${esc(quote(t.selector, 40) || 'No crop')}</span>`}</span>
            <span class="card-body"><span class="strong">${esc(quote(t.comment, 90) || '(no comment)')}</span>${pill(t.status)}<span class="muted">${esc(t.id)} · <span class="path">${esc(pageOf(t.url).label)}</span></span></span>
          </button>`;
    })
    .join('');
  return section(
    'tasks',
    'Tasks',
    'Every comment and finding, wherever it stands. Open one to see the crop and its history.',
    `<div class="views">
        <div class="tabs" role="tablist" aria-label="View">
          <button type="button" class="tab" role="tab" aria-selected="true" data-view="table">Table</button>
          <button type="button" class="tab" role="tab" aria-selected="false" data-view="gallery">Gallery</button>
        </div>
        <div class="tabs" role="group" aria-label="Show">
          <button type="button" class="tab" aria-pressed="true" data-filter="all">All</button>
          <button type="button" class="tab" aria-pressed="false" data-filter="0">Outstanding</button>
          <button type="button" class="tab" aria-pressed="false" data-filter="1">Done</button>
        </div>
      </div>
      <div data-pane="table">
        <table>
          <thead><tr><th class="col-task">Task</th><th class="col-status">Status</th><th class="col-page">Page</th><th class="col-el">Element</th><th class="col-upd">Updated</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div data-pane="gallery" hidden><div class="gallery">${cards}</div></div>
      <p class="empty" data-none hidden>Nothing in this view.</p>`,
  );
}

function pageList(d) {
  if (!d.pages.length) return section('pages', 'Pages', '', empty('No pages yet.'));
  const rows = d.pages
    .map(
      (p) => `<div class="prow">
          <span class="path strong">${esc(p.label)}</span>
          <span class="mini" role="img" aria-label="${p.pending} outstanding, ${p.done} done">${STATUSES.filter((s) => p.byStatus[s])
            .map((s) => `<span class="t-${toneOf(s)}" style="flex:${p.byStatus[s]}"></span>`)
            .join('')}</span>
          <span class="muted num">${p.pending} outstanding · ${p.total} total</span>
        </div>`,
    )
    .join('');
  return section('pages', 'Pages', 'Where the work is, worst page first.', `<div class="rows">${rows}</div>`);
}

function sentBackList(d, byId) {
  const rows = d.sentBack.slice(0, 12).map(({ id, rejected, applied }) => {
    const t = byId.get(id);
    return `<button type="button" class="arow" data-open="${esc(id)}">
          ${pill(t.status)}
          <span class="arow-main"><span class="strong">${esc(quote(t.comment, 110) || '(no comment)')}</span><span class="muted">${esc(id)} · <span class="path">${esc(pageOf(t.url).label)}</span></span></span>
          <span class="arow-side muted num">rejected ${rejected}× · applied ${applied}×</span>
        </button>`;
  });
  return section(
    'sent-back',
    'Sent back',
    'Fixes that did not take the first time. The same task returning is usually a misunderstanding, not a hard bug.',
    rows.length ? `<div class="list">${rows.join('')}</div>` : empty('Nothing has been sent back.'),
  );
}

function activityFeed(d) {
  if (!d.activity.length) return section('activity', 'Activity', '', empty('Nothing has happened here yet.'));
  const today = dayKey(d.generatedAt);
  const yesterday = dayKey(d.generatedAt - 86_400_000);
  const days = [];
  for (const e of d.activity) {
    const key = dayKey(e.at);
    if (days.at(-1)?.key !== key) days.push({ key, at: e.at, items: [] });
    days.at(-1).items.push(e);
  }
  const render = (list) =>
    list
      .map((day) => {
        const name = day.key === today ? 'Today' : day.key === yesterday ? 'Yesterday' : DAY.format(day.at);
        const items = day.items
          .map(
            (e) => `<li class="ev">
            <time datetime="${new Date(e.at).toISOString()}">${esc(CLOCK.format(e.at))}</time>
            <span class="dot t-${e.tone}" aria-hidden="true"></span>
            <span><span>${esc(e.text)}</span>${e.detail ? `<span class="muted ev-detail">${esc(e.detail)}</span>` : ''}</span>
          </li>`,
          )
          .join('');
        return `<h3 class="day">${esc(name)}</h3><ul class="feed">${items}</ul>`;
      })
      .join('');

  // Whole days up to about a screenful; the rest folds away. A feed that runs
  // for two thousand pixels buries the sections under it, and the older a day
  // is, the less anyone reads it.
  let shown = 0;
  let cut = 0;
  while (cut < days.length && (cut === 0 || shown < FEED_FOLD)) {
    shown += days[cut].items.length;
    cut += 1;
  }
  const older = days.slice(cut);
  const olderCount = older.reduce((n, day) => n + day.items.length, 0);
  /*
    A button and `hidden`, not <details>. Chrome keeps a closed <details>'
    content laid out under content-visibility, so every folded line still
    reports a box below the toggle — and ayna's own audit counted each one as
    overlapping the next section. `hidden` is display:none, which nothing
    mistakes for being on screen.
  */
  const label = `Show ${olderCount} older event${olderCount === 1 ? '' : 's'}`;
  const body =
    render(days.slice(0, cut)) +
    (older.length
      ? `<button type="button" class="more" aria-expanded="false" aria-controls="older-activity" data-more="${esc(label)}">${esc(label)}</button>
      <div id="older-activity" hidden>${render(older)}</div>`
      : '');
  return section('activity', 'Activity', `The latest ${d.activity.length} events, newest first.`, body);
}

const FEED_FOLD = 12;

function agentTable(d) {
  if (!d.agents.length) return section('agents', 'Agents', '', empty('No agent has opened a session here yet.'));
  const STATE = {
    live: ['Live', 'green'],
    quiet: ['Quiet', 'yellow'],
    ended: ['Ended', 'gray'],
    dead: ['Went away', 'red'],
  };
  const rows = d.agents
    .map((a) => {
      const [label, tone] = STATE[a.state] ?? [a.state, 'gray'];
      return `<tr>
            <td><span class="strong">${esc(a.tool)}</span><span class="sub muted wrap agent-id" title="${esc(a.agentId ?? a.id)}">${esc(short(a.agentId ?? a.id))}</span></td>
            <td><span class="pill t-${tone}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span></td>
            <td class="col-page muted">${when(a.startedAt)}</td>
            <td class="muted">${when(a.lastSeenAt)}</td>
            <td class="num">${a.claims}${a.holding ? ` <span class="muted">(${a.holding} now)</span>` : ''}</td>
          </tr>`;
    })
    .join('');
  return section(
    'agents',
    'Agents',
    'Every session that has worked in this project, most recent first.',
    `<table>
        <thead><tr><th>Agent</th><th>State</th><th class="col-page">Started</th><th>Last seen</th><th>Claims</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`,
  );
}

export function renderDashboard(d, { outDir }) {
  const byId = new Map(d.tasks.map((t) => [t.id, t]));
  const data = { tasks: d.tasks.map((t) => forPeek(t, outDir)) };
  // `<` escaped so a comment containing "</script>" cannot end the block early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const nav = [
    ['overview', 'Overview', null],
    ['attention', 'Needs attention', d.attention.length],
    ['tasks', 'Tasks', d.counts.total],
    ['pages', 'Pages', d.pages.length],
    ['sent-back', 'Sent back', d.sentBack.length],
    ['activity', 'Activity', null],
    ['agents', 'Agents', d.agents.length],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.project)} · ayna</title>
<link rel="icon" href="data:,">
<style>${CSS}</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="ws"><span class="ws-mark" aria-hidden="true">a</span><span>ayna</span></div>
    <nav aria-label="Sections">
      ${nav.map(([id, label, n]) => `<a href="#${id}"><span>${esc(label)}</span>${n ? `<span class="n">${n}</span>` : ''}</a>`).join('\n      ')}
    </nav>
    <p class="side-foot">A snapshot of <code>.ayna/ayna.db</code>. Run <code>ayna dashboard</code> again to refresh.</p>
  </aside>
  <main class="page">
    <header>
      <p class="crumbs">ayna <span aria-hidden="true">/</span> dashboard</p>
      <h1>${esc(d.project)}</h1>
      <p class="meta">${d.counts.total} task${d.counts.total === 1 ? '' : 's'} across ${d.pages.length} page${d.pages.length === 1 ? '' : 's'} · generated ${when(d.generatedAt)}</p>
    </header>
    ${overview(d)}
    ${attentionList(d, byId)}
    ${taskViews(d, outDir)}
    ${pageList(d)}
    ${sentBackList(d, byId)}
    ${activityFeed(d)}
    ${agentTable(d)}
  </main>
</div>
<aside class="peek" id="peek" role="dialog" aria-labelledby="peek-title" hidden>
  <div class="peek-top">
    <span class="muted" id="peek-id"></span>
    <button type="button" class="x" id="peek-close" aria-label="Close">×</button>
  </div>
  <div id="peek-body"></div>
</aside>
<script type="application/json" id="ayna-data">${json}</script>
<script>(${client.toString()})();</script>
</body>
</html>
`;
}

/** Gather, render, write. Returns the file and what went into it. */
export async function writeDashboard(projectDir, { outDir = path.join(projectDir, '.ayna', 'dashboard'), db, now } = {}) {
  const data = await gatherDashboard(projectDir, { db, now });
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'index.html');
  await writeFile(file, renderDashboard(data, { outDir }));
  return { file, data };
}

/*
  The page's only script. It runs in the browser, so it is written as a function
  and inlined with toString(): nothing from this module is in scope there.
  Everything it shows is built with textContent, never innerHTML — comments are
  user text, and a dashboard that ran them would be an injection waiting to happen.
*/
function client() {
  const data = JSON.parse(document.getElementById('ayna-data').textContent);
  const byId = new Map(data.tasks.map((t) => [t.id, t]));

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const relative = (ms) => {
    const s = (ms - Date.now()) / 1000;
    const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
    let v = s;
    for (const [n, unit] of steps) {
      if (Math.abs(v) < n) return rtf.format(Math.round(v), unit);
      v /= n;
    }
    return full.format(ms);
  };
  const stamp = (el) => {
    const ms = Date.parse(el.dateTime);
    if (!Number.isFinite(ms)) return;
    el.title = full.format(ms);
    el.textContent = relative(ms);
  };
  document.querySelectorAll('time[data-rel]').forEach(stamp);

  // Views and filters. Both are only visibility: the page holds every task.
  let view = 'table';
  let show = 'all';
  const apply = () => {
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== view; });
    let visible = 0;
    document.querySelectorAll('[data-pane="' + view + '"] [data-task]').forEach((el) => {
      const on = show === 'all' || el.dataset.done === show;
      el.hidden = !on;
      if (on) visible += 1;
    });
    const none = document.querySelector('[data-none]');
    if (none) none.hidden = visible > 0;
  };
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    apply();
  }));
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    show = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    apply();
  }));

  // The folded part of the activity feed.
  document.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const target = document.getElementById(b.getAttribute('aria-controls'));
    const opening = target.hidden;
    target.hidden = !opening;
    b.setAttribute('aria-expanded', String(opening));
    b.textContent = opening ? 'Hide older events' : b.dataset.more;
  }));

  // The side peek.
  const peek = document.getElementById('peek');
  const body = document.getElementById('peek-body');
  let opener = null;

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const pill = (tone, label, hint) => h('span', { class: 'pill t-' + tone, title: hint || null }, h('span', { class: 'dot', 'aria-hidden': 'true' }), label);
  const when = (iso) => {
    const t = h('time', { datetime: iso }, iso);
    stamp(t);
    return t;
  };

  const open = (id, from) => {
    const t = byId.get(id);
    if (!t) return;
    opener = from || null;
    document.getElementById('peek-id').textContent = t.id;
    const props = [
      ['Status', pill(t.tone, t.label, t.hint)],
      ['Page', t.url ? h('span', { class: 'wrap', title: t.url }, t.page) : null],
      ['Element', t.selector ? h('code', {}, t.selector) : null],
      ['Kind', t.kind],
      ['Source', t.sources.length ? h('span', { class: 'stack' }, t.sources.map((s) => h('code', {}, s))) : null],
      ['Claimed by', t.claimedBy],
      ['verify said', t.verdict && t.verdict.verdict ? [t.verdict.verdict, t.verdict.why ? ' — ' + t.verdict.why : ''] : null],
      ['Created', when(t.createdAt)],
      ['Updated', when(t.updatedAt)],
    ].filter(([, v]) => v != null && v !== '');

    const parts = [
      h('h3', { id: 'peek-title' }, t.comment || '(no comment)'),
      h('dl', { class: 'props' }, props.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      t.crop ? h('figure', { class: 'shot' }, h('img', { src: t.crop, alt: 'The element this task is about' }), h('figcaption', { class: 'muted' }, 'What was selected')) : null,
      t.attachments.length
        ? h('div', {}, h('h4', {}, 'Attachments'), t.attachments.map((a) => h('figure', { class: 'shot' }, h('img', { src: a, alt: 'An image attached to the comment' }))))
        : null,
      t.history.length
        ? h('div', {}, h('h4', {}, 'History'), h('ol', { class: 'hist' }, t.history.map((x) =>
            h('li', {}, h('span', { class: 'dot t-' + x.tone, 'aria-hidden': 'true' }), h('span', {}, h('span', { class: 'strong' }, x.label), ' ', h('span', { class: 'muted' }, when(x.at)), x.note ? h('span', { class: 'muted hist-note' }, x.note) : null)))))
        : null,
    ];
    // replaceChildren() would write a null out as the text "null".
    body.replaceChildren(...parts.filter(Boolean));
    peek.hidden = false;
    peek.scrollTop = 0;
    document.getElementById('peek-close').focus();
  };
  const close = () => {
    if (peek.hidden) return;
    peek.hidden = true;
    if (opener) opener.focus();
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) open(b.dataset.open, b);
  });
  document.getElementById('peek-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

/*
  Light, quiet, and made of type and hairlines rather than boxes and colour.
  Colour is spent on one thing — status — as soft tag fills with dark ink, so
  every pill clears the contrast floor ayna enforces on everyone else. The muted
  ink is #6f6e69, not the lighter grey this style usually reaches for: that one
  measures 4.4:1 on white and would fail ayna's own audit.
*/
const CSS = `
:root{
  --bg:#fff;--side:#f7f7f5;--text:#37352f;--muted:#6f6e69;--line:#e9e9e7;--soft:#f1f1ef;
  --hover:rgba(55,53,47,.06);--focus:#2383e2;
  --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light;
}
.t-gray{--tag-bg:#e3e2e0;--tag-ink:#32302c;--tag-dot:#91918e}
.t-brown{--tag-bg:#eee0da;--tag-ink:#442a1e;--tag-dot:#9f6b53}
.t-orange{--tag-bg:#fadec9;--tag-ink:#49290e;--tag-dot:#d9730d}
.t-yellow{--tag-bg:#fdecc8;--tag-ink:#402c1b;--tag-dot:#cb912f}
.t-green{--tag-bg:#dbeddb;--tag-ink:#1c3829;--tag-dot:#448361}
.t-blue{--tag-bg:#d3e5ef;--tag-ink:#183347;--tag-dot:#337ea9}
.t-purple{--tag-bg:#e8deee;--tag-ink:#412454;--tag-dot:#9065b0}
.t-red{--tag-bg:#ffe2dd;--tag-ink:#5d1715;--tag-dot:#d44c47}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
code{font-family:var(--mono);font-size:12px;background:rgba(135,131,120,.13);border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.strong{font-weight:500}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.wrap{overflow-wrap:anywhere}
.path{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
.col-page{min-width:120px}
.sub{display:block;font-size:12px;margin-top:2px}

.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--side) 247px,var(--line) 247px 248px,var(--bg) 248px)}
.side{position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:14px 8px;background:var(--side);border-right:1px solid var(--line)}
.ws{display:flex;align-items:center;gap:10px;padding:6px 10px 16px;font-weight:600}
.ws-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:700}
.side nav{display:flex;flex-direction:column;gap:1px}
.side a{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:0 10px;border-radius:6px;color:var(--muted);font-weight:500;text-decoration:none}
.side a:hover{background:var(--hover);color:var(--text)}
.side .n{font-size:12px;font-variant-numeric:tabular-nums}
.side-foot{margin:auto 0 0;padding:12px 10px 4px;font-size:12px;line-height:1.6;color:var(--muted)}
.side-foot code{font-size:12px;background:none;padding:0}

.page{width:100%;max-width:980px;margin:0 auto;padding:80px 64px 140px}
.crumbs{margin:0 0 32px;font-size:13px;color:var(--muted)}
h1{margin:0 0 6px;font-size:40px;line-height:1.2;font-weight:700;letter-spacing:-.015em}
.meta{margin:0;color:var(--muted)}
section{margin-top:64px;scroll-margin-top:24px}
h2{margin:0 0 4px;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.005em}
.lede{margin:0 0 18px;color:var(--muted)}
.empty{margin:12px 0 0;padding:18px 20px;border:1px dashed var(--line);border-radius:8px;color:var(--muted)}

.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}
.stat{padding:16px 18px;border:1px solid var(--line);border-radius:10px}
.stat .k{font-size:13px;color:var(--muted)}
.stat .v{margin-top:6px;font-size:30px;line-height:1.15;font-weight:600;font-variant-numeric:tabular-nums}
.stat .s{margin-top:4px;font-size:12px;color:var(--muted)}
.bar{display:flex;gap:2px;height:8px;margin:24px 0 12px;border-radius:4px;overflow:hidden;background:var(--soft)}
.bar span,.mini span{background:var(--tag-dot)}
.legend{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0;padding:0;list-style:none;font-size:13px;color:var(--muted)}
.legend li{display:flex;align-items:center;gap:7px}
.legend .n{color:var(--text);font-variant-numeric:tabular-nums}
.dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--tag-dot)}

.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:11px;background:var(--tag-bg);color:var(--tag-ink);font-size:12px;font-weight:500;line-height:1;white-space:nowrap}

.callout{padding:6px;border-radius:10px;background:var(--side)}
.list{border-top:1px solid var(--line)}
.arow{display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:14px;align-items:center;width:100%;min-height:52px;padding:10px 12px;border:0;border-radius:6px;background:none;text-align:left;cursor:pointer}
.list .arow{border-radius:0;border-bottom:1px solid var(--line)}
.arow:hover{background:var(--hover)}
.arow .pill{justify-self:start}
.arow-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.arow-main .muted{font-size:13px}
.arow-side{font-size:12px;text-align:right;line-height:1.5}

.views{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:4px 16px;border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:2px}
.tab{min-width:44px;min-height:44px;margin-bottom:-1px;padding:0 10px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);font-weight:500;cursor:pointer}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"],.tab[aria-pressed="true"]{color:var(--text);border-bottom-color:var(--text)}

table{width:100%;border-collapse:collapse}
th{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:13px;font-weight:500;text-align:left;white-space:nowrap}
td{padding:6px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:hover td{background:rgba(55,53,47,.025)}
.col-status{width:1%;white-space:nowrap}
.col-upd{width:1%;white-space:nowrap;font-size:13px}
.col-el{max-width:220px}
.open{display:block;width:100%;min-height:44px;padding:6px 0;border:0;background:none;text-align:left;cursor:pointer}
.only-narrow{display:none}

.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding-top:16px}
.card{display:flex;flex-direction:column;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;text-align:left;cursor:pointer;box-shadow:0 1px 2px rgba(15,15,15,.04)}
.card:hover{border-color:#dcdcd9}
.cover{display:grid;place-items:center;height:140px;padding:12px;background:var(--side);border-bottom:1px solid var(--line)}
.cover img{display:block;max-width:100%;max-height:116px;object-fit:contain;border-radius:4px}
.nocrop{font-family:var(--mono);font-size:12px;text-align:center;overflow-wrap:anywhere}
.card-body{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 14px 14px}
.card-body .muted{font-size:12px}

.rows{border-top:1px solid var(--line)}
.prow{display:grid;grid-template-columns:minmax(0,1fr) 180px auto;gap:18px;align-items:center;min-height:48px;padding:8px 12px;border-bottom:1px solid var(--line)}
.mini{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--soft)}
.prow .muted{font-size:13px}

.day{margin:26px 0 6px;font-size:13px;font-weight:600;color:var(--muted)}
.day:first-of-type{margin-top:8px}
.feed{margin:0;padding:0;list-style:none}
.ev{display:grid;grid-template-columns:44px 8px minmax(0,1fr);gap:12px;align-items:baseline;padding:7px 0}
.ev time{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.ev .dot{transform:translateY(-1px)}
.ev-detail{display:block;font-size:13px;overflow-wrap:anywhere}
.more{display:inline-flex;align-items:center;min-height:44px;margin:10px 0 0 -12px;padding:0 12px;border:0;border-radius:6px;background:none;color:var(--muted);font-weight:500;cursor:pointer}
.more::before{content:"";width:0;height:0;margin-right:10px;border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
.more[aria-expanded="true"]::before{transform:rotate(90deg)}
.more:hover{background:var(--hover);color:var(--text)}

.peek{position:fixed;top:0;right:0;bottom:0;z-index:10;width:min(560px,100vw);overflow-y:auto;padding:0 32px 56px;background:#fff;box-shadow:0 0 0 1px rgba(15,15,15,.05),0 12px 32px rgba(15,15,15,.10),0 32px 64px rgba(15,15,15,.08)}
.peek-top{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:10px 0;background:#fff;font-family:var(--mono);font-size:12px}
.x{width:44px;height:44px;border:0;border-radius:6px;background:none;color:var(--muted);font-size:22px;line-height:1;cursor:pointer}
.x:hover{background:var(--hover);color:var(--text)}
.peek h3{margin:12px 0 20px;font-size:26px;line-height:1.3;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.peek h4{margin:28px 0 10px;font-size:14px;font-weight:600}
.props{display:grid;grid-template-columns:120px minmax(0,1fr);margin:0;font-size:14px}
.props dt{padding:7px 0;color:var(--muted)}
.props dd{margin:0;padding:7px 0;overflow-wrap:anywhere}
.stack{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.shot{margin:24px 0 0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--side)}
.shot img{display:block;max-width:100%;margin:0 auto;border-radius:4px}
.shot figcaption{margin-top:8px;font-size:12px;text-align:center}
.hist{margin:0;padding:0;list-style:none;border-left:1px solid var(--line);margin-left:3px}
.hist li{display:flex;gap:12px;align-items:baseline;padding:6px 0 6px 0;margin-left:-4px}
.hist .dot{margin-top:6px}
.hist-note{display:block;font-size:13px}

@media (max-width:900px){
  .app{grid-template-columns:minmax(0,1fr);background:var(--bg)}
  .side{position:static;height:auto;padding:10px 8px;border-right:0;border-bottom:1px solid var(--line)}
  .ws{padding-bottom:6px}
  .side nav{flex-direction:row;flex-wrap:wrap}
  .side .n{display:none}
  .side-foot{display:none}
  .page{padding:36px 16px 96px}
  h1{font-size:32px}
  section{margin-top:48px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .col-page,.col-el,.col-upd,.agent-id{display:none}
  .only-narrow{display:inline}
  .arow{grid-template-columns:minmax(0,1fr);gap:6px}
  .arow-side{text-align:left}
  .prow{grid-template-columns:minmax(0,1fr) auto}
  .prow .mini{display:none}
  .peek{padding:0 16px 40px}
  .props{grid-template-columns:100px minmax(0,1fr)}
}
`;
