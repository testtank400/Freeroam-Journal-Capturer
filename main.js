const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

let mainWindow;
let captureInProgress = false;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let saveFolder = path.join(app.getPath('documents'), 'Freeroam Captures');

// Fail loudly instead of hanging forever on SPA/networkidle/API stalls
const NAV_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 45_000;
const INTERCEPT_WAIT_MS = 12_000;

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(data);
    if (settings.saveFolder) saveFolder = settings.saveFolder;
  } catch (e) {}
}

async function saveSettings() {
  try {
    await fs.writeFile(settingsPath, JSON.stringify({ saveFolder }, null, 2));
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);
}

function sendStatus(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', msg);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sanitizeFolderName(name) {
  return String(name || 'Untitled World')
    .replace(/[/\\?%*:|"<>!]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled World';
}

/**
 * Detect which journal shape we received.
 * Returns { format, ok, error?, warning?, unwrapped?, arrayKey? }
 */
function detectJournalFormat(json) {
  if (json == null) {
    return { format: 'empty', ok: false, error: 'Journal response was empty (null/undefined).' };
  }

  if (typeof json === 'string') {
    return { format: 'string', ok: true, warning: 'API returned a plain string instead of JSON object.' };
  }

  if (typeof json !== 'object') {
    return {
      format: 'primitive',
      ok: false,
      error: `Unexpected journal type: ${typeof json}`
    };
  }

  // FastAPI / backend error payloads
  if (typeof json.detail === 'string' && Object.keys(json).length <= 3) {
    return { format: 'api_error', ok: false, error: json.detail };
  }
  if (typeof json.error === 'string' && !json.summary && !json.entries && !json.compressedSummaries) {
    return { format: 'api_error', ok: false, error: json.error };
  }
  if (typeof json.message === 'string' && (json.status === 'error' || json.success === false)) {
    return { format: 'api_error', ok: false, error: json.message };
  }

  // Unwrap common envelopes
  for (const key of ['journal', 'data', 'result', 'payload', 'body']) {
    if (json[key] != null && typeof json[key] === 'object') {
      const inner = detectJournalFormat(json[key]);
      if (inner.ok) {
        return { ...inner, format: `${inner.format}_wrapped_${key}`, unwrapped: json[key] };
      }
    }
  }

  // Current Freeroam journal (summary + chapters + entityState + threads)
  if (
    json.summary ||
    json.compressedSummaries ||
    json.narrativeThreads ||
    json.entityState ||
    json.chapters ||
    json.plotDocId != null
  ) {
    return { format: 'summary_v2', ok: true };
  }

  if (Array.isArray(json.entries) || Array.isArray(json)) {
    return { format: 'entries_v1', ok: true };
  }

  const arrayKeys = Object.keys(json).filter((k) => Array.isArray(json[k]) && json[k].length > 0);
  if (arrayKeys.length > 0) {
    const texty = arrayKeys.find((k) => {
      const sample = json[k][0];
      return (
        sample &&
        typeof sample === 'object' &&
        (sample.content || sample.text || sample.body || sample.summary || sample.title || sample.name)
      );
    });
    if (texty) {
      return {
        format: 'adaptive_array',
        ok: true,
        warning: `Unrecognized journal shape; treating "${texty}" as entries.`,
        arrayKey: texty
      };
    }
  }

  if (Object.keys(json).length > 0) {
    return {
      format: 'unknown',
      ok: true,
      warning:
        'Journal JSON shape is unrecognized. Saved raw JSON; markdown is a structured dump. ' +
        'Please report this so conversion can be updated.'
    };
  }

  return { format: 'empty', ok: false, error: 'Journal response was an empty object {}.' };
}

function formatChapterLabel(item, index) {
  if (Array.isArray(item.chapter_numbers) && item.chapter_numbers.length) {
    return item.chapter_numbers.join(', ');
  }
  if (item.chapter_number != null) return String(item.chapter_number);
  if (item.chapter != null) return String(item.chapter);
  if (item.title) return item.title;
  return String(index + 1);
}

function entryBody(entry) {
  return (
    entry.content ??
    entry.text ??
    entry.body ??
    entry.summary ??
    entry.markdown ??
    entry.html ??
    null
  );
}

function appendEntityGroup(md, title, items) {
  if (!Array.isArray(items) || items.length === 0) return md;
  md += `## ${title}\n\n`;
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      md += `- ${String(item)}\n`;
      continue;
    }
    const name = item.name || item.title || 'Untitled';
    md += `### ${name}\n\n`;
    if (item.state) md += `**State:** ${item.state}\n\n`;
    if (item.appearance) md += `**Appearance:** ${item.appearance}\n\n`;
    if (item.description) md += `${item.description}\n\n`;
    if (item.position) md += `**Position:** ${item.position}\n\n`;
    if (item.display_headshot_url || item.headshot_url) {
      const img = item.display_headshot_url || item.headshot_url;
      md += `![${name}](${img})\n\n`;
    }
    md += `---\n\n`;
  }
  return md;
}

/**
 * Convert journal JSON → markdown for known + adaptive formats.
 * Always returns a string; never throws on unknown shapes.
 */
function convertToMarkdown(json, detection) {
  const det = detection || detectJournalFormat(json);
  const source = det.unwrapped != null ? det.unwrapped : json;

  if (det.format === 'string') {
    return `# Journal Export\n\n${source}\n`;
  }

  // summary_v1 / summary_v2 (current Freeroam journal)
  if (
    det.format === 'summary_v1' ||
    det.format === 'summary_v2' ||
    (source &&
      (source.summary ||
        source.compressedSummaries ||
        source.narrativeThreads ||
        source.entityState ||
        source.chapters))
  ) {
    let md = `# ${source.summary ? 'Story Summary' : 'Journal Export'}\n\n`;

    if (source.summary) {
      md += `## Summary\n\n${source.summary}\n\n---\n\n`;
    }

    const chapters =
      source.compressedSummaries ||
      source.chapterSummaries ||
      [];
    if (Array.isArray(chapters) && chapters.length > 0) {
      md += `## Chapter Summaries\n\n`;
      chapters.forEach((item, i) => {
        const body = entryBody(item) ?? JSON.stringify(item, null, 2);
        md += `### Chapter ${formatChapterLabel(item, i)}\n\n${body}\n\n---\n\n`;
      });
    }

    // Panel chapters (image panels, not prose summaries)
    if (Array.isArray(source.chapters) && source.chapters.length > 0) {
      md += `## Chapter Panels\n\n`;
      // Sort by chapter_number when present
      const panels = [...source.chapters].sort((a, b) => {
        const an = a.chapter_number ?? 0;
        const bn = b.chapter_number ?? 0;
        return an - bn;
      });
      panels.forEach((panel) => {
        const n = panel.chapter_number ?? '?';
        md += `### Chapter ${n}\n\n`;
        if (panel.image_url) {
          md += `![Chapter ${n}](${panel.image_url})\n\n`;
          md += `Panel: ${panel.image_url}\n\n`;
        }
        if (panel.panel_external_id) {
          md += `Panel ID: \`${panel.panel_external_id}\`\n\n`;
        }
        const body = entryBody(panel);
        if (body) md += `${body}\n\n`;
        md += `---\n\n`;
      });
    }

    const threads = source.narrativeThreads || source.threads || [];
    if (Array.isArray(threads) && threads.length > 0) {
      md += `## Narrative Threads\n\n`;
      threads.forEach((thread) => {
        const title = thread.title || thread.name || 'Thread';
        const meta = [thread.importance, thread.status].filter(Boolean).join(' · ');
        md += `### ${title}${meta ? ` (${meta})` : ''}\n\n`;
        const notes = thread.notes || thread.items || [];
        if (Array.isArray(notes) && notes.length > 0) {
          notes.forEach((note) => {
            if (typeof note === 'string') md += `- ${note}\n`;
            else if (note && typeof note === 'object') {
              md += `- ${note.content || note.text || note.note || JSON.stringify(note)}\n`;
            }
          });
        } else if (entryBody(thread)) {
          md += `${entryBody(thread)}\n`;
        }
        md += `\n---\n\n`;
      });
    }

    // Entity state (characters, locations, misc)
    if (source.entityState && typeof source.entityState === 'object') {
      md += `## Entity State\n\n`;
      md = appendEntityGroup(md, 'Characters', source.entityState.characters);
      md = appendEntityGroup(md, 'Locations', source.entityState.locations);
      md = appendEntityGroup(md, 'Misc', source.entityState.misc);
      // Any other entity groups
      for (const [key, value] of Object.entries(source.entityState)) {
        if (['characters', 'locations', 'misc'].includes(key)) continue;
        if (Array.isArray(value) && value.length) {
          md = appendEntityGroup(md, key.charAt(0).toUpperCase() + key.slice(1), value);
        }
      }
    }

    if (source.plotDocId != null) {
      md += `\n_Plot doc id: ${source.plotDocId}_\n`;
    }

    return md;
  }

  // entries array / top-level array
  if (det.format === 'entries_v1' || Array.isArray(source?.entries) || Array.isArray(source)) {
    const entries = Array.isArray(source) ? source : source.entries || [];
    if (entries.length === 0) {
      return `# Journal Export\n\n_(No entries in journal.)_\n`;
    }
    return entries
      .map((entry, i) => {
        if (typeof entry === 'string') {
          return `## Entry ${i + 1}\n\n${entry}\n\n---\n`;
        }
        const title = entry.title || entry.name || `Entry ${i + 1}`;
        const date = entry.createdAt || entry.date || entry.timestamp;
        const dateLine = date ? `**${new Date(date).toLocaleString()}**\n\n` : '';
        const content = entryBody(entry) ?? JSON.stringify(entry, null, 2);
        return `## ${title}\n${dateLine}${content}\n\n---\n`;
      })
      .join('\n');
  }

  if (det.format === 'adaptive_array' && det.arrayKey) {
    const entries = source[det.arrayKey] || [];
    let md = `# Journal Export\n\n_Adaptive conversion using field \`${det.arrayKey}\`._\n\n`;
    entries.forEach((entry, i) => {
      if (typeof entry === 'string') {
        md += `## Entry ${i + 1}\n\n${entry}\n\n---\n\n`;
        return;
      }
      const title = entry.title || entry.name || `Entry ${i + 1}`;
      const content = entryBody(entry) ?? JSON.stringify(entry, null, 2);
      md += `## ${title}\n\n${content}\n\n---\n\n`;
    });
    return md;
  }

  const keys = source && typeof source === 'object' ? Object.keys(source) : [];
  let md = `# Journal Export (Unknown Format)\n\n`;
  md += `The API returned a JSON shape this app does not fully recognize.\n\n`;
  md += `**Top-level keys:** ${keys.length ? keys.map((k) => `\`${k}\``).join(', ') : '_(none)_'}\n\n`;
  md += `Raw payload is also saved as \`journal-raw.json\`.\n\n---\n\n`;
  md += '```json\n' + JSON.stringify(source, null, 2) + '\n```\n';
  return md;
}

/**
 * In-page fetch (last resort). CORS / offline / wrong origin often surface as "Failed to fetch".
 */
async function pageFetchJson(page, url, timeoutMs) {
  return page.evaluate(
    async ({ url, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: {
            accept: 'application/json, */*;q=0.8',
            'cache-control': 'no-cache',
            pragma: 'no-cache'
          }
        });

        const contentType = res.headers.get('content-type') || '';
        const text = await res.text();

        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          return {
            ok: false,
            status: res.status,
            json: null,
            error: `Response was not JSON (HTTP ${res.status}, content-type: ${contentType})`,
            textPreview: text.slice(0, 300),
            method: 'page_fetch'
          };
        }

        if (!res.ok) {
          const detail =
            (json && (json.detail || json.error || json.message)) ||
            `HTTP ${res.status}: ${res.statusText}`;
          return { ok: false, status: res.status, json, error: String(detail), method: 'page_fetch' };
        }

        return { ok: true, status: res.status, json, method: 'page_fetch' };
      } catch (e) {
        const msg =
          e && e.name === 'AbortError'
            ? `Fetch aborted after ${Math.round(timeoutMs / 1000)}s`
            : e.message || String(e);
        return { ok: false, status: 0, json: null, error: msg, method: 'page_fetch' };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, timeoutMs }
  );
}

/**
 * Playwright request API shares the browser context cookies but is NOT subject to page CORS.
 * This is the preferred path after network interception.
 */
async function contextFetchJson(context, url, timeoutMs) {
  try {
    const res = await context.request.get(url, {
      timeout: timeoutMs,
      headers: {
        accept: 'application/json, */*;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache'
      }
    });
    const status = res.status();
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        status,
        json: null,
        error: `Response was not JSON (HTTP ${status})`,
        textPreview: text.slice(0, 300),
        method: 'context_request'
      };
    }

    if (!res.ok()) {
      const detail =
        (json && (json.detail || json.error || json.message)) || `HTTP ${status}`;
      return { ok: false, status, json, error: String(detail), method: 'context_request' };
    }

    return { ok: true, status, json, method: 'context_request' };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: e.message || String(e),
      method: 'context_request'
    };
  }
}

/**
 * Try multiple strategies to get JSON for a URL.
 * 1) already-intercepted body
 * 2) Playwright context.request (cookies, no CORS)
 * 3) in-page fetch (credentials: include)
 */
async function fetchJsonMulti(context, page, url, timeoutMs, intercepted) {
  if (intercepted && intercepted.json != null) {
    return {
      ok: true,
      status: intercepted.status || 200,
      json: intercepted.json,
      method: 'network_intercept'
    };
  }

  sendStatus(`   → trying context request: ${url}`);
  const viaContext = await contextFetchJson(context, url, timeoutMs);
  if (viaContext.ok) return viaContext;
  sendStatus(`   ⚠️ context request failed: ${viaContext.error}`);

  sendStatus(`   → trying in-page fetch: ${url}`);
  const viaPage = await pageFetchJson(page, url, timeoutMs);
  if (viaPage.ok) return viaPage;

  // Merge error details
  return {
    ok: false,
    status: viaPage.status || viaContext.status || 0,
    json: viaPage.json || viaContext.json,
    error: `All fetch methods failed. context: ${viaContext.error}; page: ${viaPage.error}`,
    textPreview: viaPage.textPreview || viaContext.textPreview,
    method: 'all_failed'
  };
}

function authHint(status) {
  if (status === 401 || status === 403) {
    return ' Auth failed — click Reset Login, then capture again (Chrome will open for sign-in).';
  }
  return '';
}

function isLoginUrl(u) {
  if (!u) return false;
  const s = u.toLowerCase();
  return (
    s.includes('accounts.google.com') ||
    s.includes('/login') ||
    s.includes('/signin') ||
    s.includes('/sign-in') ||
    s.includes('auth0.com')
  );
}

/**
 * Listen for Freeroam API JSON while the SPA loads.
 * Many "Failed to fetch" cases go away if we just capture the app's own XHR.
 */
function installApiInterceptor(page, worldId) {
  const bag = {
    journal: null,
    world: null
  };

  const onResponse = async (response) => {
    try {
      const u = response.url();
      if (!u.includes('getfreeroam.com') && !u.includes('freeroam')) return;
      const status = response.status();
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (status < 200 || status >= 300) return;
      if (!ct.includes('json') && !u.includes('journal') && !u.includes('story-json')) return;

      const looksJournal =
        u.includes(`/world/${worldId}/journal`) ||
        (u.includes('/journal') && u.includes(worldId));
      const looksWorld =
        u.includes(`internal-world-story-json/${worldId}`) ||
        u.includes(`/world/${worldId}`) && (u.includes('story') || u.includes('meta'));

      if (!looksJournal && !looksWorld) return;

      let json = null;
      try {
        json = await response.json();
      } catch {
        return;
      }

      if (looksJournal && !bag.journal) {
        bag.journal = { status, json, url: u };
        sendStatus(`📥 Intercepted journal response from SPA (${u.slice(0, 80)}…)`);
      } else if (looksWorld && !bag.world) {
        bag.world = { status, json, url: u };
        sendStatus(`📥 Intercepted world metadata from SPA`);
      }
    } catch {
      // ignore interceptor errors
    }
  };

  page.on('response', onResponse);
  return {
    bag,
    dispose() {
      try {
        page.off('response', onResponse);
      } catch {
        // ignore
      }
    }
  };
}

async function waitForIntercept(bag, key, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (bag[key]) return bag[key];
    await new Promise((r) => setTimeout(r, 200));
  }
  return bag[key];
}

ipcMain.handle('get-save-folder', () => saveFolder);

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: saveFolder
  });
  if (!result.canceled) {
    saveFolder = result.filePaths[0];
    await saveSettings();
  }
  return saveFolder;
});

ipcMain.handle('reset-login', async () => {
  const userDataDir = path.join(app.getPath('userData'), 'freeroam-profile');
  if (fsSync.existsSync(userDataDir)) {
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
  return { success: true, message: '✅ Login cleared. Next capture will open Chrome visibly.' };
});

ipcMain.handle('start-capture', async (event, url) => {
  if (captureInProgress) {
    return { success: false, message: '❌ A capture is already running. Wait for it to finish or time out.' };
  }

  if (!url || !url.includes('/world/')) {
    return { success: false, message: '❌ Please provide a valid Freeroam URL (must contain /world/)' };
  }

  // Normalize to .../world/<id>
  const worldIdIndex = url.indexOf('/world/');
  if (worldIdIndex !== -1) {
    const afterWorld = url.substring(worldIdIndex + 7);
    const nextSlash = afterWorld.indexOf('/');
    if (nextSlash !== -1) {
      url = url.substring(0, worldIdIndex + 7 + nextSlash);
    }
  }

  const worldIdMatch = url.match(/\/world\/([a-f0-9-]+)/i);
  if (!worldIdMatch) {
    return { success: false, message: '❌ Could not extract world ID from URL' };
  }
  const worldId = worldIdMatch[1];

  captureInProgress = true;
  let context = null;
  let interceptor = null;

  try {
    const userDataDir = path.join(app.getPath('userData'), 'freeroam-profile');
    const profileExists = fsSync.existsSync(path.join(userDataDir, 'Default'));
    const headless = profileExists;

    sendStatus(
      headless
        ? '🚀 Launching Chrome (saved login)...'
        : '🚀 Launching Chrome — log in if prompted, then wait...'
    );

    context = await withTimeout(
      chromium.launchPersistentContext(userDataDir, {
        channel: 'chrome',
        headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-infobars'
        ],
        viewport: null,
        timeout: LAUNCH_TIMEOUT_MS
      }),
      LAUNCH_TIMEOUT_MS + 5_000,
      'Chrome launch'
    );

    const page = context.pages()[0] || (await context.newPage());
    interceptor = installApiInterceptor(page, worldId);

    sendStatus(`🌐 Opening world page (timeout ${NAV_TIMEOUT_MS / 1000}s)...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // Give the SPA time to fire its own journal XHRs
    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    sendStatus(`🔗 Landed on: ${finalUrl}`);

    if (isLoginUrl(finalUrl)) {
      const message =
        '❌ Redirected to a login page. Click Reset Login, capture again, and sign in when Chrome opens.';
      sendStatus(message);
      return { success: false, message };
    }

    // Wait briefly for SPA network intercepts
    sendStatus(`👂 Listening for SPA API responses (up to ${INTERCEPT_WAIT_MS / 1000}s)...`);
    await waitForIntercept(interceptor.bag, 'journal', INTERCEPT_WAIT_MS);

    // World name (best-effort)
    let folderTitle = 'Untitled World';
    sendStatus('📡 Fetching world metadata...');
    try {
      const worldCandidates = [
        `https://getfreeroam.com/internal-world-story-json/${worldId}`,
        `https://www.getfreeroam.com/internal-world-story-json/${worldId}`
      ];

      let worldResult = null;
      for (const worldDataUrl of worldCandidates) {
        worldResult = await fetchJsonMulti(
          context,
          page,
          worldDataUrl,
          FETCH_TIMEOUT_MS,
          interceptor.bag.world
        );
        if (worldResult.ok) break;
      }

      if (worldResult && worldResult.ok && worldResult.json) {
        const name =
          worldResult.json.world?.name ||
          worldResult.json.name ||
          worldResult.json.title ||
          worldResult.json.world?.title;
        if (name) {
          folderTitle = sanitizeFolderName(name);
          sendStatus(`📝 World name: ${folderTitle} (via ${worldResult.method})`);
        } else {
          folderTitle = sanitizeFolderName(await page.title());
          sendStatus(`⚠️ No world name in metadata; using page title: ${folderTitle}`);
        }
      } else {
        folderTitle = sanitizeFolderName(await page.title());
        sendStatus(
          `⚠️ World metadata failed (${worldResult?.error || 'unknown'}); using page title: ${folderTitle}`
        );
      }
    } catch (e) {
      try {
        folderTitle = sanitizeFolderName(await page.title());
      } catch {
        folderTitle = 'Untitled World';
      }
      sendStatus(`⚠️ Could not fetch world name (${e.message}); using: ${folderTitle}`);
    }

    // Journal — required. Try several URL shapes Freeroam has used over time.
    const origin = (() => {
      try {
        return new URL(finalUrl).origin;
      } catch {
        return 'https://getfreeroam.com';
      }
    })();

    const journalCandidates = [
      `${origin}/api/world/${worldId}/journal?_t=${Date.now()}`,
      `https://getfreeroam.com/api/world/${worldId}/journal?_t=${Date.now()}`,
      `https://www.getfreeroam.com/api/world/${worldId}/journal?_t=${Date.now()}`
    ];
    // de-dupe
    const seen = new Set();
    const uniqueJournalUrls = journalCandidates.filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });

    sendStatus(`📡 Fetching journal API (timeout ${FETCH_TIMEOUT_MS / 1000}s)...`);

    let journalResult = null;
    for (const journalUrl of uniqueJournalUrls) {
      journalResult = await fetchJsonMulti(
        context,
        page,
        journalUrl,
        FETCH_TIMEOUT_MS,
        interceptor.bag.journal
      );
      if (journalResult.ok) {
        sendStatus(`✅ Journal fetched via ${journalResult.method}`);
        break;
      }
      sendStatus(`   ⚠️ ${journalUrl} → ${journalResult.error}`);
    }

    if (!journalResult || !journalResult.ok) {
      const hint = authHint(journalResult?.status);
      const preview = journalResult?.textPreview
        ? `\nPreview: ${journalResult.textPreview}`
        : '';
      const message =
        `❌ Journal API failed: ${journalResult?.error || 'unknown error'}.${hint}` +
        `\nTried: ${uniqueJournalUrls.join(' | ')}${preview}` +
        `\n💡 Tip: open the world in normal Chrome, confirm you're logged in, then Reset Login and recapture.`;
      sendStatus(message);
      return { success: false, message };
    }

    const json = journalResult.json;
    const detection = detectJournalFormat(json);

    if (!detection.ok) {
      if (json != null && typeof json === 'object') {
        try {
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const folderPath = path.join(
            saveFolder,
            `${folderTitle} - FAILED - ${timestamp}`
          );
          await fs.mkdir(folderPath, { recursive: true });
          await fs.writeFile(
            path.join(folderPath, 'journal-raw.json'),
            JSON.stringify(json, null, 2)
          );
          sendStatus(`💾 Saved failing payload to: ${folderPath}`);
        } catch (saveErr) {
          sendStatus(`⚠️ Could not save failing payload: ${saveErr.message}`);
        }
      }

      const message = `❌ ${detection.error || 'Invalid journal response.'}${authHint(journalResult.status)}`;
      sendStatus(message);
      return { success: false, message };
    }

    if (detection.warning) {
      sendStatus(`⚠️ ${detection.warning}`);
    } else {
      sendStatus(`✅ Recognized journal format: ${detection.format}`);
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const folderName = `${folderTitle} - ${timestamp}`;
    const folderPath = path.join(saveFolder, folderName);

    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, 'journal-raw.json'), JSON.stringify(json, null, 2));

    const md = convertToMarkdown(json, detection);
    await fs.writeFile(path.join(folderPath, 'journal.md'), md);

    await fs.writeFile(
      path.join(folderPath, 'capture-meta.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          worldId,
          sourceUrl: url,
          finalUrl,
          fetchMethod: journalResult.method,
          format: detection.format,
          warning: detection.warning || null,
          topLevelKeys:
            json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json) : null
        },
        null,
        2
      )
    );

    const successMsg = detection.warning
      ? `⚠️ Saved with warnings to: ${folderPath}`
      : `🎉 SUCCESS! Saved to: ${folderPath}`;
    sendStatus(successMsg);

    await dialog.showMessageBox(mainWindow, {
      type: detection.warning ? 'warning' : 'info',
      message: detection.warning
        ? `Journal saved, but the format was only partially recognized.\n\n${detection.warning}\n\nFolder:\n${folderPath}`
        : `Journal saved!\n\nFolder:\n${folderPath}`
    });

    shell.openPath(folderPath);
    return { success: true, message: successMsg, folderPath, format: detection.format };
  } catch (e) {
    const message = `❌ Error: ${e.message || String(e)}`;
    sendStatus(message);
    sendStatus(
      '💡 If this keeps happening: try Reset Login, check your internet, or confirm the Freeroam URL still works in Chrome.'
    );
    return { success: false, message };
  } finally {
    captureInProgress = false;
    if (interceptor) interceptor.dispose();
    if (context) {
      try {
        await context.close();
      } catch (e) {
        // ignore close errors
      }
    }
  }
});

app.whenReady().then(async () => {
  await loadSettings();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
