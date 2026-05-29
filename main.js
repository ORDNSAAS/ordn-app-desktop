const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const net = require('net')
const path = require('path')
const fs = require('fs')

function getConfigPath() {
  return path.join(app.getPath('userData'), 'ordn-config.json')
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) }
  catch { return { printerIp: '192.168.1.100', printerPort: 9100 } }
}

function saveConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
}

function buildEscPos(job) {
  const ESC = 0x1B, GS = 0x1D, LF = 0x0A
  const parts = []
  const add = (data) => parts.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'))

  add(Buffer.from([ESC, 0x40]))
  add(Buffer.from([ESC, 0x74, 0x02]))

  if (job.tipo === 'comanda') {
    add(Buffer.from([ESC, 0x61, 0x01]))
    add(Buffer.from([ESC, 0x45, 0x01]))
    add(`COMANDA #${job.folio || ''}\n`)
    add(`Mesa: ${job.mesa || ''}\n`)
    if (job.comensal) add(`Comensal: ${job.comensal}\n`)
    add(Buffer.from([ESC, 0x45, 0x00]))
    add(Buffer.from([ESC, 0x61, 0x00]))
    add('--------------------------------\n')
    for (const linea of (job.lineas || [])) {
      add(`${linea.cantidad}x ${linea.nombre}\n`)
      for (const mod of (linea.modificadores || [])) add(`   * ${mod}\n`)
      if (linea.nota) add(`   Nota: ${linea.nota}\n`)
    }
    add('--------------------------------\n')
  } else {
    add(Buffer.from([ESC, 0x61, 0x01]))
    add(Buffer.from([ESC, 0x45, 0x01]))
    add(`${job.restaurante || 'ORDN OS'}\n`)
    add(Buffer.from([ESC, 0x45, 0x00]))
    add(Buffer.from([ESC, 0x61, 0x00]))
    if (job.mesa) add(`Mesa: ${job.mesa}\n`)
    add('--------------------------------\n')
    for (const linea of (job.lineas || [])) {
      const nombre = String(linea.nombre || '').slice(0, 20).padEnd(20)
      const precio = `$${Number(linea.total || 0).toFixed(2)}`
      add(`${linea.cantidad}x ${nombre} ${precio}\n`)
      for (const mod of (linea.modificadores || [])) add(`   * ${mod}\n`)
    }
    add('--------------------------------\n')
    add(Buffer.from([ESC, 0x61, 0x02]))
    add(Buffer.from([ESC, 0x45, 0x01]))
    add(`TOTAL: $${Number(job.total || 0).toFixed(2)}\n`)
    add(Buffer.from([ESC, 0x45, 0x00]))
    add(Buffer.from([ESC, 0x61, 0x00]))
    if (job.folio) add(`Folio: ${job.folio}\n`)
  }

  add(Buffer.from([LF, LF, LF]))
  add(Buffer.from([GS, 0x56, 0x00]))
  return Buffer.concat(parts)
}

app.whenReady().then(() => {
  ipcMain.handle('ordn-print', async (_event, job) => {
    const config = loadConfig()
    const ip   = job.printerIp   || config.printerIp
    const port = job.printerPort || config.printerPort

    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(5000)
      socket.connect(port, ip, () => {
        socket.write(buildEscPos(job))
        socket.end()
        resolve({ ok: true })
      })
      socket.on('error',   (err) => resolve({ ok: false, error: err.message }))
      socket.on('timeout', ()    => {
        socket.destroy()
        resolve({ ok: false, error: `Timeout — impresora no responde en ${ip}:${port}` })
      })
    })
  })

  ipcMain.handle('ordn-get-config',  ()             => loadConfig())
  ipcMain.handle('ordn-save-config', (_event, cfg)  => { saveConfig(cfg); return { ok: true } })

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'ORDN OS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  Menu.setApplicationMenu(null)
  win.loadURL('https://app.ordnos.com')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
