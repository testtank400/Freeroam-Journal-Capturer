const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;

let mainWindow;
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let saveFolder = path.join(app.getPath('documents'), 'Freeroam Captures');

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

async function convertToMarkdown(json) {
  if (Array.isArray(json?.entries) || Array.isArray(json)) {
    const entries = Array.isArray(json) ? json : json.entries || [];
    return entries.map((entry, i) => {
      const title = entry.title || entry.name || `Entry ${i + 1}`;
      const date = entry.createdAt || entry.date || new Date().toISOString();
      const content = entry.content || entry.text || JSON.stringify(entry, null, 2);
      return `## ${title}\n**${new Date(date).toLocaleString()}**\n\n${content}\n\n---\n`;
    }).join('\n');
  }
  return `# Journal Export\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
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
  if (require('fs').existsSync(userDataDir)) {
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
  return { success: true, message: '✅ Login cleared. Next capture will open Chrome visibly.' };
});

ipcMain.handle('start-capture', async (event, url) => {
  if (!url || !url.includes('/world/')) {
    return { success: false, message: '❌ Please provide a valid Freeroam URL (must contain /world/)' };
  }

  // Trim anything after the world ID (stops at next slash or end of string)
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

  const userDataDir = path.join(app.getPath('userData'), 'freeroam-profile');
  const profileExists = require('fs').existsSync(path.join(userDataDir, 'Default'));
  const headless = profileExists;

  mainWindow.webContents.send('status', '🚀 Launching real Chrome...');

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars'
    ],
    viewport: null,
    timeout: 0
  });

  const page = context.pages()[0] || await context.newPage();

  await page.goto(url, { waitUntil: 'networkidle', timeout: 0 });
  await page.waitForTimeout(800);

  // Get the world name from the new API
  const worldDataUrl = `https://getfreeroam.com/internal-world-story-json/${worldId}`;
  mainWindow.webContents.send('status', `📡 Fetching world data...`);

  let folderTitle = 'Untitled World';
  try {
    const worldResponse = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'accept': 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'pragma': 'no-cache',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        }
      });
      return await res.json();
    }, worldDataUrl);

    if (worldResponse.world && worldResponse.world.name) {
      folderTitle = worldResponse.world.name;
      mainWindow.webContents.send('status', `📝 World name: ${folderTitle}`);
    }
  } catch (e) {
    mainWindow.webContents.send('status', `⚠️ Could not fetch world name, using page title`);
    folderTitle = (await page.title()).replace(/[/\\?%*:|"<>]/g, '_');
  }

  // Get the journal
  const journalUrl = `https://getfreeroam.com/api/world/${worldId}/journal`;
  mainWindow.webContents.send('status', `📡 Calling journal API directly...`);

  try {
    const json = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'pragma': 'no-cache',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        }
      });
      return await res.json();
    }, journalUrl);

    if (json.detail) {
      mainWindow.webContents.send('status', `❌ API Error: ${json.detail}`);
      await context.close();
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const folderName = `${folderTitle} - ${timestamp}`;
    const folderPath = path.join(saveFolder, folderName);

    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, 'journal-raw.json'), JSON.stringify(json, null, 2));
    const md = await convertToMarkdown(json);
    await fs.writeFile(path.join(folderPath, 'journal.md'), md);

    mainWindow.webContents.send('status', `🎉 SUCCESS! Saved to: ${folderPath}`);
    dialog.showMessageBox(mainWindow, { message: `Journal saved!\n\nFolder: ${folderPath}` });

    shell.openPath(folderPath);
    await context.close();
  } catch (e) {
    mainWindow.webContents.send('status', `❌ Error: ${e.message}`);
    await context.close();
  }
});

app.whenReady().then(async () => {
  await loadSettings();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
