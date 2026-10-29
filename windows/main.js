// CC-1 for Windows: Electron shell around the same local server + UI as the Mac app.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 47470;
process.env.PORT = String(PORT);
const URL_ = `http://127.0.0.1:${PORT}`;

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win;
function run(js) { if (win) win.webContents.executeJavaScript(js).catch(() => {}); }

function createWindow() {
  require('./server.js');
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 640,
    backgroundColor: '#c9c6bf', title: 'CC-1', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL_)) { e.preventDefault(); shell.openExternal(url); } });
  let tries = 0;
  const load = () => http.get(URL_ + '/api/projects', r => { r.resume(); win.loadURL(URL_); })
    .on('error', () => { if (++tries < 40) setTimeout(load, 250); });
  load();

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Add Project Folder…', accelerator: 'CmdOrCtrl+O', click: () => run("document.querySelector('#btnAdd').click()") },
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => run("document.querySelector('#btnNewS').click()") },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => run("document.querySelector('#btnSet').click()") },
      { type: 'separator' }, { role: 'quit' } ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
  ]));
}

ipcMain.on('notify', (_e, { title, body }) => {
  if (!Notification.isSupported() || (win && win.isFocused())) return;
  const n = new Notification({ title: String(title || 'CC-1'), body: String(body || '') });
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  n.show();
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' });
  return r.canceled ? null : r.filePaths[0];
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.setAppUserModelId('app.cc1.gui');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
