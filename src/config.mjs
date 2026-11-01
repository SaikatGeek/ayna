import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  target: {
    name: 'demo',
    // Directory that holds the UI source. Ayna serves this statically when `url` is null.
    root: 'demo',
    // Set to e.g. "http://localhost:5173" to point at your own dev server instead.
    url: null,
    // Optional command to boot that dev server (run from the repo root).
    startCommand: null,
    port: 4173,
    // Pages to capture, relative to the target URL. Add every route worth
    // reviewing — one shot of the landing page tells you nothing about /pricing.
    routes: ['/'],
    /*
      There is deliberately no `editGlobs` here. It used to exist and was never
      enforced, which is worse than not having it: a setting that looks like a
      sandbox but isn't. The real boundary is `root` — it's what gets snapshotted,
      what `restore` rolls back, and what the skill tells Claude it may touch.
      That is a convention plus an undo, not a security guarantee. Point `root`
      somewhere you are happy to have rewritten.
    */
  },
  viewports: [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ],
  loop: {
    iterations: 3,
    model: 'opus',
    // Headless by default: as a plugin this runs inside someone's session, and a
    // Chrome window stealing focus mid-task is worse than not seeing it. `--headed`
    // opts back in.
    headless: true,
    // Stop early once the critic scores the UI at or above this (0-10).
    targetScore: 8.5,
    // Re-screenshot after edits and ask the brain whether the fixes landed.
    verify: true,
    // Roll the iteration back if the page breaks (blank render / new console errors).
    autoRevert: true,
  },
  goal:
    'A modern, polished product landing page: confident typography, deliberate spacing ' +
    'rhythm, a coherent color system, clear visual hierarchy, and a layout that holds up ' +
    'on both desktop and mobile.',
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override;
  if (override === null || typeof override !== 'object') {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/*
  The palette, so ayna can look like the thing it is sitting on top of.

  A review panel is somebody else's furniture in somebody else's room. Shipping
  one fixed theme means it clashes with half the apps it opens, and the honest
  answer to "will you use this" was no while the colours were mine and not
  theirs. Anything unset falls back to the default, so a partial theme is a valid
  theme — one line to change the accent is the common case.
*/
export const DEFAULT_THEME = {
  /*
    Paper, with one gold fill.

    The rail used to be near-black and a quarter of the window wide. Next to the
    light apps most people review, that made ayna's own chrome the heaviest
    thing on screen: the page you came to judge read as the smaller of the two,
    and an empty rail read as a panel that had failed to load. White chrome
    separated by hairlines sits beside an app instead of competing with it.

    The gold stays, as a FILL — the one call to action, the send arrow, the
    marks you make on the page. As ink or a hairline on white the same gold is
    2.49:1, which is why `accent-strong` exists: the same hue, dark enough to be
    read, or to ring a focused field.

    Before this the rule was kormoOS's — black is the material, the warm tone
    only the light. It suited a dark canvas, and any of it can come back: a
    theme in ayna.config.json overrides these keys, and anything unset keeps its
    default, so one line is a valid theme.
  */

  // ── surfaces: one paper, told apart by hairlines rather than by shade ───
  surface: '#ffffff', // the rail
  bar: '#ffffff', // the docked control bar
  panel: '#ffffff', // popovers, the task list, review cards
  wash: '#f3f3f6', // the soft fill: hover, the mode track, your own messages
  line: '#e6e6eb', // a hairline, never a coloured stroke

  // ── ink: three steps, each measured on white ────────────────────────────
  text: '#17171a', // 17.9:1
  muted: '#5f5f6b', // 6.3:1
  /*
    5.0:1 on `surface`, and still 4.5 on `wash`.

    The dimmest ink is still ink somebody has to read — these are the timestamps
    down the rail — and a value once chosen for it failed the contrast floor
    ayna enforces on everyone else's UI.
  */
  dim: '#6e6e7a',

  // The popover is the same paper, so it needs no separate ink; these exist
  // because overlay.js asks for them by name.
  'panel-text': '#17171a',
  'panel-line': '#e6e6eb',

  // ── the gold ────────────────────────────────────────────────────────────
  // Sampled from kormoOS's gold ramp. Luminance 0.37, so what is written on it
  // is black at 7.95:1 — computed by inkOn, never assumed.
  accent: '#de9446',
  'accent-strong': '#a8641f', // the gold as ink: text, focus rings (4.66:1)
  live: '#a8641f',
  you: '#a8641f',
  agent: '#7356c8',
  ayna: '#0e7c6b',

  // ── state: readable as text on white, and white is readable on them ─────
  good: '#1e7f45',
  warn: '#a15c07',
  bad: '#c93c37',
};

/*
  The dark palette the paper one replaced, kept whole.

  A theme that names a dark ground and no inks — the README's own example sets
  only `accent`, `surface` and `bar` — would otherwise inherit the paper
  defaults' near-black text and lay it on its near-black rail. When the ground a
  project chose is dark, every key it left unset comes from here instead, so a
  partial dark theme stays a dark theme rather than an unreadable one.
*/
export const DARK_THEME = {
  surface: '#0a0a0b',
  bar: '#0d0d0f',
  panel: '#121214',
  wash: '#1c1c1f',
  line: 'rgba(255,255,255,0.075)',
  text: '#f4f2ef',
  muted: 'rgba(255,255,255,0.62)',
  dim: 'rgba(255,255,255,0.46)', // 4.6:1 on `surface`
  'panel-text': '#f4f2ef',
  'panel-line': 'rgba(255,255,255,0.10)',
  accent: '#de9446',
  'accent-strong': '#e0b978', // on a dark ground the lighter gold is the readable one
  live: '#e0b978',
  you: '#e8b478',
  agent: '#c9a2e8',
  ayna: '#79d4c0',
  good: '#7bc47f',
  warn: '#e0a458',
  bad: '#e0685f',
};

/** The project's theme over whichever default matches the ground it chose. */
export function resolveTheme(user = {}) {
  const l = luminance(user.surface ?? user.bar ?? user.panel);
  const base = l !== null && l < 0.18 ? DARK_THEME : DEFAULT_THEME;
  return { ...base, ...user };
}

/*
  What colour text belongs on a fill: black or white, whichever reads better.

  This used to be a cut at luminance 0.4, worked out inside the page, and 0.4 is
  not where black overtakes white — the two ratios cross near 0.18. Every fill
  in between got white: the default gold measures 0.37, so "Send to Claude", the
  rail's send arrow and every selection tag were white on gold at 2.49:1 while
  black on the same gold is 7.95:1. Comparing the two ratios cannot pick the
  worse one, wherever a threshold would have been put.

  It lives here rather than in the page so it can be tested without a browser —
  the in-page version was only ever reached by the CLI, never by a test.
*/
const BLACK_INK = '#0a0a0a';
const WHITE_INK = '#ffffff';

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white for text on `hex`; null when `hex` is not a #rrggbb colour. */
export function inkOn(hex) {
  const l = luminance(hex);
  if (l === null) return null;
  const black = (l + 0.05) / (luminance(BLACK_INK) + 0.05);
  const white = 1.05 / (l + 0.05);
  return black >= white ? BLACK_INK : WHITE_INK;
}

/**
 * The theme plus `on-<key>` for every colour something is written on. A project
 * that names its own `on-accent` keeps it; everything else is measured.
 */
export function withInks(theme) {
  const out = { ...theme };
  for (const key of ['accent', 'good', 'bad', 'warn', 'live']) {
    const ink = inkOn(theme?.[key]);
    if (ink && !(`on-${key}` in out)) out[`on-${key}`] = ink;
  }
  return out;
}

export async function loadConfig(rootDir) {
  const file = path.join(rootDir, 'ayna.config.json');
  let user = {};
  try {
    await access(file);
    user = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // No config yet — defaults are fine.
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg.theme = resolveTheme(cfg.theme ?? {});
  cfg.rootDir = rootDir;
  cfg.targetDir = path.resolve(rootDir, cfg.target.root);
  cfg.runsDir = path.join(rootDir, '.ayna', 'runs');
  cfg.configFile = file;
  return cfg;
}

export async function writeConfig(rootDir, cfg = DEFAULT_CONFIG) {
  const file = path.join(rootDir, 'ayna.config.json');
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}
