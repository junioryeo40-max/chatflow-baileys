const express = require('express')
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
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

async function startSession(agentId) {
  const sessionDir = path.join('./sessions', agentId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['ChatFlow', 'Chrome', '1.0.0'],
  })

  sessions.set(agentId, { socket: sock, qr: null, status: 'CONNECTING', phoneNumber: null })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    const session = sessions.get(agentId)
    if (!session) return

    if (qr) {
      session.qr = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
      session.status = 'QR_PENDING'
    }

    if (connection === 'open') {
      session.status = 'CONNECTED'
      session.qr = null
      session.phoneNumber = sock.user?.id?.split(':')[0] || null
      console.log(`Agent ${agentId} connecté — ${session.phoneNumber}`)

      if (CHATFLOW_URL) {
        axios.post(`${CHATFLOW_URL}/api/whatsapp/webhook`, {
          event: 'connected', agentId, phoneNumber: session.phoneNumber
        }, { headers: { 'x-secret': SECRET } }).catch(() => {})
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const reconnect = code !== DisconnectReason.loggedOut
      session.status = reconnect ? 'RECONNECTING' : 'DISCONNECTED'
      console.log(`Agent ${agentId} déconnecté — reconnect: ${reconnect}`)

      if (reconnect) {
        setTimeout(() => startSession(agentId), 5000)
      } else {
        sessions.delete(agentId)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '')
      if (!phone || phone.includes('g.us')) continue // ignorer les groupes

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      if (!text.trim()) continue

      console.log(`Message reçu — agent: ${agentId} | de: ${phone} | texte: ${text}`)

      if (!CHATFLOW_URL) continue

      try {
        const res = await axios.post(`${CHATFLOW_URL}/api/whatsapp/webhook`, {
          event: 'message', agentId, phone, message: text
        }, { headers: { 'x-secret': SECRET } })

        const reply = res.data?.response
        if (reply) {
          await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: reply })
        }
      } catch (err) {
        console.error(`Erreur traitement message: ${err.message}`)
      }
    }
  })
}

// Routes
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }))

app.post('/session/start', auth, async (req, res) => {
  const { agentId } = req.body
  if (!agentId) return res.status(400).json({ error: 'agentId requis' })

  if (!sessions.has(agentId)) {
    await startSession(agentId)
  }

  res.json({ success: true, status: sessions.get(agentId)?.status })
})

app.get('/session/:agentId/qr', auth, async (req, res) => {
  const { agentId } = req.params

  if (!sessions.has(agentId)) {
    await startSession(agentId)
    await new Promise(r => setTimeout(r, 4000))
  }

  const session = sessions.get(agentId)
  if (!session) return res.status(404).json({ error: 'Session introuvable' })

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
