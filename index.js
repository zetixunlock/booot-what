const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

let currentQR = '';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot activo.');
});

app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
        <h2>⌛ Esperando código QR o bot ya conectado...</h2>
      </div>
    `);
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
    res.status(500).send('Error generando el QR');
  }
});

app.listen(port, () => console.log(`🌐 Servidor en puerto ${port}`));

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`🔄 Iniciando Baileys con versión v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📲 NUEVO CÓDIGO QR GENERADO EN /qr');
    }

    if (connection === 'close') {
      currentQR = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠️ Conexión cerrada. Razón:', statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('🧹 Limpiando archivos de autenticación...');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
      }

      setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      currentQR = '';
      console.log('==============================================');
      console.log('✅ ¡BOT CONECTADO EXITOSAMENTE Y RESPONDIENDO!');
      console.log('==============================================');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const body = 
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        console.log(`📩 Mensaje recibido de ${from}: "${body}"`);

        if (body.includes('>By Zetix-Unlock-Bot')) continue;

        const command = body.trim().toLowerCase();

        if (command === '!ping') {
          await sock.sendMessage(from, { text: '🏓 *¡Pong!* El bot está activo y respondiendo.\n\n>By Zetix-Unlock-Bot' });
        }

        if (command === '!help' || command === '!menu') {
          await sock.sendMessage(from, {
            text: '📋 *MENÚ DE COMANDOS:*\n\n' +
                  '🔹 *!ping* - Estado del bot\n' +
                  '🔹 *!todos* - Mencionar miembros\n' +
                  '🔹 *!help* - Menú\n\n' +
                  '>By Zetix-Unlock-Bot'
          });
        }

        if (command === '!todos' && isGroup) {
          const groupMetadata = await sock.groupMetadata(from);
          const participants = groupMetadata.participants;
          let mentions = participants.map(p => p.id);
          let text = `📣 *LLAMADO GENERAL* 📣\n\n` + mentions.map(m => `👉 @${m.split('@')[0]}`).join('\n') + `\n\n>By Zetix-Unlock-Bot`;
          await sock.sendMessage(from, { text, mentions });
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });
}

connectToWhatsApp();