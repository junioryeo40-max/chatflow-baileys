const express = require('express')
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const pino = require('pino')

const app = express()
app.use(express.json())

const sessions = new Map()
const CHATFLOW_URL = process.env.CHATFLOW_URL || ''
const SECRET = process.env.BAILEYS_SECRET || 'chatflow-secret'

function auth(req, res, next) {
  if (req.headers['x-secret'] !== SECRET) return res.status(401).json({ error: 'Non autorisé' })
  next()
}

async function startSession(agentId, fresh = false) {
  // Nettoyer l'ancienne session si elle existe
  if (sessions.has(agentId)) {
    try { sessions.get(agentId).socket?.end() } catch {}
    sessions.delete(agentId)
  }

  const sessionDir = path.join('./sessions', agentId)

  // Si fresh=true ou si on vient d'un 405, supprimer les fichiers corrompus
  if (fresh && fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true })
    console.log(`[${agentId}] Session supprimée — redémarrage propre`)
  }

  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

    const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['ChatFlow', 'Safari', '604.1'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
  })

  sessions.set(agentId, { socket: sock, qr: null, status: 'CONNECTING', phoneNumber: null })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    const session = sessions.get(agentId)
    if (!session) return

    console.log(`[${agentId}] connection.update:`, { connection, hasQR: !!qr })

    if (qr) {
      try {
        session.qr = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
        session.status = 'QR_PENDING'
        console.log(`[${agentId}] QR généré`)
      } catch (e) {
        console.error(`[${agentId}] Erreur QR:`, e.message)
      }
    }

    if (connection === 'open') {
      session.status = 'CONNECTED'
      session.qr = null
      session.phoneNumber = sock.user?.id?.split(':')[0] || null
      console.log(`[${agentId}] Connecté — ${session.phoneNumber}`)

      if (CHATFLOW_URL) {
        axios.post(`${CHATFLOW_URL}/api/whatsapp/webhook`, {
          event: 'connected', agentId, phoneNumber: session.phoneNumber
        }, { headers: { 'x-secret': SECRET } }).catch(() => {})
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log(`[${agentId}] Fermé — code: ${code}`)

      if (code === DisconnectReason.loggedOut) {
        session.status = 'DISCONNECTED'
        sessions.delete(agentId)
      } else if (code === 405) {
        // Session corrompue — redémarrer proprement
        console.log(`[${agentId}] Session corrompue (405) — redémarrage propre dans 5s`)
        session.status = 'RECONNECTING'
        setTimeout(() => startSession(agentId, true), 5000)
      } else {
        session.status = 'RECONNECTING'
        setTimeout(() => startSession(agentId), 5000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '')
      if (!phone || phone.includes('g.us')) continue

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || ''

      if (!text.trim()) continue
      console.log(`[${agentId}] Message de ${phone}: ${text}`)

      if (!CHATFLOW_URL) continue

      try {
        const res = await axios.post(`${CHATFLOW_URL}/api/whatsapp/webhook`, {
          event: 'message', agentId, phone, message: text
        }, { headers: { 'x-secret': SECRET }, timeout: 15000 })

        const reply = res.data?.response
        if (reply) {
          await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: reply })
        }
      } catch (err) {
        console.error(`[${agentId}] Erreur message:`, err.message)
      }
    }
  })

  return sock
}

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }))

app.post('/session/start', auth, async (req, res) => {
  const { agentId } = req.body
  if (!agentId) return res.status(400).json({ error: 'agentId requis' })

  const existing = sessions.get(agentId)
  if (existing && existing.status === 'CONNECTED') {
    return res.json({ success: true, status: 'CONNECTED' })
  }

  // Toujours démarrer proprement (fresh) depuis le dashboard
  await startSession(agentId, true)
  res.json({ success: true, status: 'CONNECTING' })
})

app.get('/session/:agentId/qr', auth, (req, res) => {
  const { agentId } = req.params
  const session = sessions.get(agentId)

  if (!session) return res.json({ qr: null, status: 'DISCONNECTED' })
  res.json({ qr: session.qr, status: session.status })
})

app.get('/session/:agentId/status', auth, (req, res) => {
  const { agentId } = req.params
  const session = sessions.get(agentId)
  res.json({
    status: session?.status ?? 'DISCONNECTED',
    phoneNumber: session?.phoneNumber ?? null
  })
})

app.post('/session/:agentId/disconnect', auth, async (req, res) => {
  const { agentId } = req.params
  const session = sessions.get(agentId)
  if (session?.socket) {
    await session.socket.logout().catch(() => {})
    sessions.delete(agentId)
  }
  const sessionDir = path.join('./sessions', agentId)
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true })
  res.json({ success: true })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`ChatFlow Baileys Server — port ${PORT}`))
