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
  res.send('🤖 Zetix-Unlock-Bot activo y en línea.');
});

app.get('/qr', async (req, res) => {
  if (!currentQR) return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">⌛ Esperando QR o bot ya conectado...</h2>');
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

app.listen(port, () => console.log(`🌐 Servidor en puerto ${port}`));

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
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
      console.log('📲 ¡NUEVO CÓDIGO QR LISTO EN /qr!');
    }

    if (connection === 'close') {
      currentQR = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠️ Conexión cerrada. Código de estado:', statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('🧹 Limpiando sesión expirada...');
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {
          console.error('Error limpiando sesión:', e);
        }
      }

      console.log('🔄 Reintentando conexión en 3 segundos...');
      setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      currentQR = '';
      console.log('✅ ¡BOT CONECTADO CORRECTAMENTE Y ESCUCHANDO CHATS!');
    }
  });

  // Listener principal de mensajes
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      if (!chatUpdate.messages) return;

      for (const msg of chatUpdate.messages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        // Extraer texto del mensaje de cualquier formato posible
        const body = 
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          '';

        console.log(`📩 Mensaje detectado en [${from}]: "${body}"`);

        // Omitir firmas de respuestas propias para evitar bucles
        if (body.includes('>By Zetix-Unlock-Bot')) continue;

        const command = body.trim().toLowerCase();

        // Comando !ping
        if (command === '!ping') {
          console.log('⚡ Ejecutando !ping...');
          await sock.sendMessage(from, { text: '🏓 *¡Pong!* El bot está activo y respondiendo.\n\n>By Zetix-Unlock-Bot' });
        }

        // Comando !help o !menu
        if (command === '!help' || command === '!menu') {
          console.log('⚡ Ejecutando !help...');
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
          console.log('⚡ Ejecutando !todos...');
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