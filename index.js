const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

let currentQR = '';

app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot está en línea y funcionando 24/7!');
});

app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send(`
      <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
        <h2>⌛ Esperando código QR o bot ya conectado...</h2>
        <p>Si el bot ya está vinculado, no se mostrará ningún QR.</p>
      </div>
    `);
  }

  try {
    const qrImageUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Escanear QR - Zetix Bot</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif; background: #0b141a; color: #fff; }
            img { border: 10px solid white; border-radius: 12px; max-width: 300px; }
            h1 { font-size: 20px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h1>📲 ESCANEA ESTE CÓDIGO QR CON WHATSAPP</h1>
          <img src="${qrImageUrl}" alt="Código QR" />
          <p style="margin-top: 20px; color: #8696a0;">Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generando la imagen del QR');
  }
});

app.listen(port, () => {
  console.log(`🌐 Servidor corriendo en el puerto ${port}`);
});

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📲 ¡Nuevo código QR generado! Ingresa a /qr para vincular.');
    }

    if (connection === 'close') {
      currentQR = '';
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('🔄 Reconectando...');
        connectToWhatsApp();
      } else {
        console.log('❌ Sesión cerrada.');
      }
    } else if (connection === 'open') {
      currentQR = '';
      console.log('✅ ¡Conexión establecida con éxito con WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        const body = 
          msg.message.conversation || 
          msg.message.extendedTextMessage?.text || 
          '';

        const command = body.trim().toLowerCase();

        // Comando !help
        if (command === '!help' || command === '!menu') {
          const helpText = 
            `📋 *MENÚ DE COMANDOS - ZETIX UNLOCK BOT* 🤖\n\n` +
            `🔹 *!ping* : Verifica la conexión del bot.\n` +
            `🔹 *!todos* : Etiqueta a todos los miembros (solo grupos).\n` +
            `🔹 *!help* : Muestra este menú.\n\n` +
            `>By Zetix-Unlock-Bot`;

          await sock.sendMessage(from, { text: helpText });
        }

        // Comando !ping
        if (command === '!ping') {
          await sock.sendMessage(from, {
            text: `🏓 *¡Pong!* El bot está activo y respondiendo. ⚡\n\n>By Zetix-Unlock-Bot`
          });
        }

        // Comando !todos
        if (command === '!todos' && isGroup) {
          const groupMetadata = await sock.groupMetadata(from);
          const groupName = groupMetadata.subject;
          const participants = groupMetadata.participants;

          let mentions = [];
          let text = `📣 *LLAMADO GENERAL EN ${groupName.toUpperCase()}* 📣\n\n`;

          for (let participant of participants) {
            mentions.push(participant.id);
            text += `👉 @${participant.id.split('@')[0]}\n`;
          }

          text += `\n💬 *Atención a todos los miembros.*\n\n>By Zetix-Unlock-Bot`;
          await sock.sendMessage(from, { text, mentions });
        }

        // Anti-link
        if (isGroup && (body.includes('chat.whatsapp.com/') || body.includes('wa.me/'))) {
          await sock.sendMessage(from, {
            text: `⚠️ *¡ALERTA DE ANTI-LINK!* ⚠️\n\nEnlaces no permitidos. 🚫\n\n>By Zetix-Unlock-Bot`
          });
          await sock.sendMessage(from, { delete: msg.key });
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

  cron.schedule('0 9 * * *', () => {
    console.log('⏰ Tarea automatizada activa.');
  });
}

connectToWhatsApp();