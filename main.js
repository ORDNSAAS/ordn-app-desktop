const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const { autoUpdater } = require('electron-updater')
const { createClient } = require('@supabase/supabase-js')
const net = require('net')
const path = require('path')
const fs = require('fs')
const os = require('os')

const SUPABASE_URL = 'https://uwpikmytqqyinbcsauut.supabase.co'

function getConfigPath() {
  return path.join(app.getPath('userData'), 'ordn-config.json')
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) }
  catch { return { token: null, restaurante_id: null, impresoras: {} } }
}

function saveConfig(config) {
  const current = loadConfig()
  fs.writeFileSync(getConfigPath(), JSON.stringify({ ...current, ...config }, null, 2))
}

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3cGlrbXl0cXF5aW5iY3NhdXV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ2NzIzNDMsImV4cCI6MjA2MDI0ODM0M30.jfnMOvuTGdGCEIlWs4OphF4bHSETM-JTbQNuAI_ealw'
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3cGlrbXl0cXF5aW5iY3NhdXV0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzU3MjAyNiwiZXhwIjoyMDkzMTQ4MDI2fQ.ZZdisFNOQBoL4GG-ldCc8oAVtnYlBmQow3KIT5_T9n4'

async function fetchImpresoras(token, restaurante_id) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/impresoras_areas?select=area_id,es_principal,impresoras(nombre_windows)&restaurante_id=eq.${restaurante_id}&es_principal=eq.true`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        }
      }
    )
    const rows = await res.json()
    if (!Array.isArray(rows)) {
      console.error('fetchImpresoras error:', JSON.stringify(rows))
      return {}
    }
    const map = {}
    for (const row of rows) {
      if (row.area_id && row.impresoras?.nombre_windows) {
        map[row.area_id] = { nombre_windows: row.impresoras.nombre_windows }
      }
    }
    return map
  } catch (e) {
    console.error('fetchImpresoras exception:', e)
    return {}
  }
}

async function fetchPrintJob(jobId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/print_jobs?id=eq.${jobId}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        }
      }
    )
    const rows = await res.json()
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  } catch { return null }
}

async function marcarJobImpreso(jobId, estado, error_msg) {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/print_jobs?id=eq.${jobId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ estado, error: error_msg || null })
      }
    )
  } catch (e) { console.error('marcarJobImpreso error:', e) }
}

async function procesarJob(job) {
  const config = loadConfig()
  let impresoras = config.impresoras || {}
  if (Object.keys(impresoras).length === 0 && config.restaurante_id) {
    impresoras = await fetchImpresoras(null, config.restaurante_id)
    saveConfig({ impresoras })
  }
  const imp = impresoras[job.area_id]
  if (!imp || !imp.nombre_windows) {
    await marcarJobImpreso(job.id, 'error', `No hay impresora de Windows para area_id ${job.area_id}`)
    return
  }
  const result = await printToWindows(imp.nombre_windows, job.payload)
  if (result.ok) {
    await marcarJobImpreso(job.id, 'impreso')
  } else {
    await marcarJobImpreso(job.id, 'error', result.error)
  }
}

let supabaseRealtime = null
let canalRealtime = null

function suscribirseRealtime(restaurante_id) {
  if (!supabaseRealtime) {
    const ws = require('ws')
    supabaseRealtime = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      realtime: { transport: ws, params: { eventsPerSecond: 10 } },
    })
  }
  if (canalRealtime) {
    supabaseRealtime.removeChannel(canalRealtime)
    canalRealtime = null
  }
  canalRealtime = supabaseRealtime
    .channel(`print_jobs_${restaurante_id}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'print_jobs', filter: `restaurante_id=eq.${restaurante_id}` },
      async (payload) => {
        const job = payload.new
        if (job && job.estado === 'pendiente') {
          await procesarJob(job)
        }
      }
    )
    .subscribe((status) => {
      console.log('Realtime status:', status)
    })
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

function printToImpresora(ip, port, job) {
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
}

function buildTextoPlano(job) {
  const lineas = []
  if (job.tipo === 'comanda') {
    lineas.push(`COMANDA #${job.folio || ''}`)
    lineas.push(`Mesa: ${job.mesa || ''}`)
    if (job.comensal) lineas.push(`Comensal: ${job.comensal}`)
    lineas.push('--------------------------------')
    for (const l of (job.lineas || [])) {
      lineas.push(`${l.cantidad}x ${l.nombre}`)
      for (const m of (l.modificadores || [])) lineas.push(`   * ${m}`)
      if (l.nota) lineas.push(`   Nota: ${l.nota}`)
    }
    lineas.push('--------------------------------')
  } else {
    lineas.push(job.restaurante || 'ORDN OS')
    if (job.mesa) lineas.push(`Mesa: ${job.mesa}`)
    lineas.push('--------------------------------')
    for (const l of (job.lineas || [])) {
      lineas.push(`${l.cantidad}x ${l.nombre}`)
      for (const m of (l.modificadores || [])) lineas.push(`   * ${m}`)
    }
    lineas.push('--------------------------------')
  }
  return lineas.join('\n')
}

function printToWindows(nombreWindows, job) {
  return new Promise((resolve) => {
    try {
      const { exec } = require('child_process')
      const buffer = buildEscPos(job)
      const tmp = path.join(os.tmpdir(), `ordn_${Date.now()}.bin`)
      fs.writeFileSync(tmp, buffer)
      const cmd = `copy /b "${tmp}" "\\\\localhost\\${nombreWindows}"`
      exec(cmd, { windowsHide: true }, (err) => {
        try { fs.unlinkSync(tmp) } catch {}
        if (err) resolve({ ok: false, error: err.message })
        else resolve({ ok: true })
      })
    } catch (e) {
      resolve({ ok: false, error: e.message })
    }
  })
}

function setupAutoUpdater(win) {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', () => {
    win.webContents.executeJavaScript(`if (window.ordnDesktopUpdateAvailable) window.ordnDesktopUpdateAvailable()`)
  })
  autoUpdater.on('update-downloaded', () => {
    win.webContents.executeJavaScript(`if (window.ordnDesktopUpdateReady) window.ordnDesktopUpdateReady()`)
  })
  autoUpdater.checkForUpdatesAndNotify()
}

app.whenReady().then(() => {
  ipcMain.handle('ordn-print', async (_event, job) => {
    const config = loadConfig()
    const destino = job.destino || 'caja'

    let impresoras = config.impresoras || {}

    if (config.token && config.restaurante_id && Object.keys(impresoras).length === 0) {
      impresoras = await fetchImpresoras(config.token, config.restaurante_id)
      saveConfig({ impresoras })
    }

    const imp = impresoras[destino] || impresoras['caja']
    if (!imp) return { ok: false, error: `No hay impresora configurada para ${destino}` }

    return printToImpresora(imp.ip, imp.port, job)
  })

  ipcMain.handle('ordn-get-config',  ()            => loadConfig())
  ipcMain.handle('ordn-save-config', (_event, cfg) => { saveConfig(cfg); return { ok: true } })
  ipcMain.handle('ordn-sync-impresoras', async (_event, { token, restaurante_id }) => {
    const impresoras = await fetchImpresoras(token, restaurante_id)
    saveConfig({ token, restaurante_id, impresoras })
    suscribirseRealtime(restaurante_id)
    return { ok: true, impresoras }
  })
  ipcMain.handle('ordn-install-update', () => { autoUpdater.quitAndInstall(); return { ok: true } })
  ipcMain.handle('ordn-listar-impresoras-windows', async (event) => {
    const printers = await event.sender.getPrintersAsync()
    return printers.map((p) => p.name)
  })

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

  const config = loadConfig()
  if (config.restaurante_id) {
    suscribirseRealtime(config.restaurante_id)
  }
  win.once('ready-to-show', () => setupAutoUpdater(win))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
