const express = require('express')
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const pino = require('pino')

const app = express()
app.use(express.json())

const sessions = new Map()
const CHATFLOW_URL = process.env.CHATFLOW_URL || ''
const SECRET = process.env.BAILEYS_SECRET || 'chatflow-secret'
const logger = pino({ level: 'silent' })

function auth(req, res, next) {
  if (req.headers['x-secret'] !== SECRET) return res.status(401).json({ error: 'Non autorisé' })
  next()
}

function clearSession(agentId) {
  if (sessions.has(agentId)) {
    try { sessions.get(agentId).socket?.end() } catch {}
    sessions.delete(agentId)
  }
  const sessionDir = path.join('./sessions', agentId)
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true })
}

async function startSession(agentId, phoneNumber) {
  if (sessions.has(agentId)) {
    try { sessions.get(agentId).socket?.end() } catch {}
    sessions.delete(agentId)
  }

  const sessionDir = path.join('./sessions', agentId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  })

  sessions.set(agentId, {
    socket: sock,
    pairingCode: null,
    status: 'CONNECTING',
    phoneNumber: null
  })

  sock.ev.on('creds.update', saveCreds)

  // Générer le pairing code dès que le socket est prêt
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    const session = sessions.get(agentId)
    if (!session) return

    console.log(`[${agentId}] connection.update: ${connection}`)

    if (connection === 'open') {
      session.status = 'CONNECTED'
      session.pairingCode = null
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
      } else {
        session.status = 'RECONNECTING'
        setTimeout(() => startSession(agentId, phoneNumber), 8000)
      }
    }

    // Générer le pairing code quand le socket est en attente d'auth
    if (!sock.authState.creds.registered && phoneNumber && !session.pairingCode && connection !== 'open') {
      try {
        const clean = phoneNumber.replace(/\D/g, '')
        const code = await sock.requestPairingCode(clean)
        session.pairingCode = code
        session.status = 'PAIRING'
        console.log(`[${agentId}] Pairing code généré: ${code}`)
      } catch (e) {
        console.error(`[${agentId}] Erreur pairing code:`, e.message)
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
        console.error(`[${agentId}] Erreur:`, err.message)
      }
    }
  })
}

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }))

// Démarrer session avec numéro de téléphone → génère pairing code
app.post('/session/start', auth, async (req, res) => {
  const { agentId, phoneNumber } = req.body
  if (!agentId || !phoneNumber) return res.status(400).json({ error: 'agentId et phoneNumber requis' })

  clearSession(agentId)
  await startSession(agentId, phoneNumber)

  // Attendre que le pairing code soit généré (max 15s)
  let attempts = 0
  while (attempts < 15) {
    await new Promise(r => setTimeout(r, 1000))
    const session = sessions.get(agentId)
    if (session?.pairingCode) {
      return res.json({ success: true, pairingCode: session.pairingCode, status: 'PAIRING' })
    }
    if (session?.status === 'CONNECTED') {
      return res.json({ success: true, pairingCode: null, status: 'CONNECTED' })
    }
    attempts++
  }

  res.json({ success: true, pairingCode: null, status: 'CONNECTING' })
})

app.get('/session/:agentId/status', auth, (req, res) => {
  const { agentId } = req.params
  const session = sessions.get(agentId)
  res.json({
    status: session?.status ?? 'DISCONNECTED',
    phoneNumber: session?.phoneNumber ?? null,
    pairingCode: session?.pairingCode ?? null
  })
})

app.post('/session/:agentId/disconnect', auth, async (req, res) => {
  const { agentId } = req.params
  clearSession(agentId)
  res.json({ success: true })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`ChatFlow Baileys Server — port ${PORT}`))
