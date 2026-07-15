const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let expressAppProcess;

// Function to check if the local server is up and running
function checkServerReady(url, callback) {
  http.get(url, (res) => {
    if (res.statusCode === 200) {
      callback(true);
    } else {
      callback(false);
    }
  }).on('error', () => {
    callback(false);
  });
}

function startExpressServer() {
  // Only start the bundled server when running as a packaged .exe.
  // In "npm run electron:dev" the server is already running separately
  // via "npm run dev" (tsx server.ts) on the same port, so requiring the
  // bundled file here would just fail trying to bind an already-used port.
  if (!app.isPackaged) {
    console.log('Modo desarrollo: usando el servidor de "npm run dev" ya iniciado.');
    return;
  }

  try {
    process.env.NODE_ENV = 'production';
    process.env.APP_VERSION = app.getVersion();
    require('./dist/server.cjs');
    console.log('Servidor Express local iniciado correctamente desde Electron.');
  } catch (err) {
    console.error('Error al iniciar el servidor Express interno:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    title: 'Generador de Avisos Fiscales',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0B3159',
      symbolColor: '#FFFFFF',
      height: 44,
    },
    icon: path.join(__dirname, 'assets', 'app.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Los enlaces externos (p. ej. "crear API key en Google AI Studio") deben
  // abrirse en el navegador del sistema. Sin esto, target="_blank" abría una
  // ventana Electron vacía y el usuario no llegaba nunca a la página.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      // Las capturas guardadas se sirven desde el propio servidor local:
      // esas sí se abren en una ventana de la app.
      if (!url.startsWith('http://localhost:3000')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  const localServerUrl = 'http://localhost:3000';

  // Poll local server until it responds, then load the window URL
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    checkServerReady(localServerUrl + '/api/health', (ready) => {
      if (ready) {
        clearInterval(interval);
        mainWindow.loadURL(localServerUrl);
      } else if (attempts > 15) {
        // Fallback if server takes too long to respond
        clearInterval(interval);
        mainWindow.loadURL(localServerUrl);
      }
    });
  }, 300);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- Actualizaciones automáticas vía GitHub Releases ----
// Mismo flujo que EscanerFotos: comprobar en segundo plano, preguntar antes de
// descargar, barra de progreso, e instalar en silencio (reabre la app sola).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function comprobarActualizaciones() {
  if (!app.isPackaged) return; // solo tiene sentido en el .exe instalado

  autoUpdater.checkForUpdates().catch(() => {
    // Sin internet o error de red: fallamos en silencio, como EscanerFotos.
  });
}

autoUpdater.on('update-available', async (info) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Actualización disponible',
    message: `Hay una versión nueva de Generador de Avisos Fiscales (${info.version}).`,
    detail: '¿Descargar e instalar ahora?',
    buttons: ['Sí', 'Más tarde'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    autoUpdater.downloadUpdate().catch(() => {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Actualización',
        message: 'No se pudo descargar la actualización. Revisa tu conexión e inténtalo más tarde.',
      });
    });
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) mainWindow.setProgressBar(progress.percent / 100);
});

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) mainWindow.setProgressBar(-1);
  autoUpdater.quitAndInstall();
});

autoUpdater.on('error', () => {
  if (mainWindow) mainWindow.setProgressBar(-1);
  // Silencioso: igual que EscanerFotos, no molestamos si falla la comprobación.
});

// Start local Express server first, then boot the Electron window
app.whenReady().then(() => {
  // Start server
  startExpressServer();

  // Create Electron Window
  createWindow();
  comprobarActualizaciones();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
