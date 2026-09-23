const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

let currentQR = '';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot activo y respondiendo.');
});

app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">⌛ Esperando QR o bot ya conectado...</h2>');
  }
  try {
    const qrImageUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0b141a;color:#fff;font-family:sans-serif;">
        <h2>📲 ESCANEA EL CÓDIGO QR CON WHATSAPP</h2>
        <img src="${qrImageUrl}" style="border:10px solid #fff;border-radius:12px;max-width:300px;" />
      </div>
    `);
  } catch (err) {
    res.status(500).send('Error generando el código QR');
  }
});

app.listen(port, () => console.log(`🌐 Servidor corriendo en puerto ${port}`));

// Extractor universal de texto de Baileys
function extractMessageText(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.conversation ||
    ''
  );
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    browser: ["Zetix Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📲 CÓDIGO QR LISTO EN /qr');
    }

    if (connection === 'close') {
      currentQR = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠️ Conexión cerrada. Código:', statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('🧹 Limpiando archivos de autenticación...');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
      }

      setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      currentQR = '';
      console.log('==============================================');
      console.log('✅ ¡BOT LISTO Y RESPONDIENDO CHATS EN TIEMPO REAL!');
      console.log('==============================================');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        // Extraer el texto completo
        const body = extractMessageText(msg);

        // Imprimir en consola de Render para verificación exacta
        if (body) {
          console.log(`📩 Mensaje procesado de ${from}: "${body}"`);
        }

        // Ignorar mensajes enviados por el propio bot para evitar bucles
        if (msg.key.fromMe || body.includes('>By Zetix-Unlock-Bot')) continue;

        const command = body.trim().toLowerCase();

        // Comando !ping
        if (command === '!ping') {
          console.log('⚡ Ejecutando respuesta !ping...');
          await sock.sendMessage(from, { text: '🏓 *¡Pong!* El bot está activo y respondiendo.\n\n>By Zetix-Unlock-Bot' });
        }

        // Comando !help o !menu
        if (command === '!help' || command === '!menu') {
          console.log('⚡ Ejecutando respuesta !help...');
          await sock.sendMessage(from, {
            text: '📋 *MENÚ DE COMANDOS:*\n\n' +
                  '🔹 *!ping* - Probar velocidad de respuesta\n' +
                  '🔹 *!todos* - Mencionar a todos los miembros\n' +
                  '🔹 *!help* - Ver menú de ayuda\n\n' +
                  '>By Zetix-Unlock-Bot'
          });
        }

        // Comando !todos
        if (command === '!todos' && isGroup) {
          console.log('⚡ Ejecutando respuesta !todos...');
          const groupMetadata = await sock.groupMetadata(from);
          const participants = groupMetadata.participants;
          let mentions = participants.map(p => p.id);
          let text = `📣 *ATENCIÓN A TODOS LOS MIEMBROS* 📣\n\n` + mentions.map(m => `👉 @${m.split('@')[0]}`).join('\n') + `\n\n>By Zetix-Unlock-Bot`;
          await sock.sendMessage(from, { text, mentions });
        }
      }
    } catch (err) {
      console.error('Error procesando el mensaje:', err);
    }
  });
}

connectToWhatsApp();