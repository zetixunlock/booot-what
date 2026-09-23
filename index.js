const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

let currentQR = '';

app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot está activo.');
});

app.get('/qr', async (req, res) => {
  if (!currentQR) return res.send('<h2>⌛ Esperando QR o bot ya conectado.</h2>');
  try {
    const qrImageUrl = await QRCode.toDataURL(currentQR);
    res.send(`<div style="text-align:center"><img src="${qrImageUrl}" /></div>`);
  } catch (err) {
    res.status(500).send('Error QR');
  }
});

app.listen(port, () => console.log(`🌐 Servidor en puerto ${port}`));

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
    if (qr) currentQR = qr;
    if (connection === 'close') {
      currentQR = '';
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      currentQR = '';
      console.log('✅ ¡CONEXIÓN EXITOSA CON WHATSAPP!');
    }
  });

  // DIAGNÓSTICO DE MENSAJES
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('📩 Evento messages.upsert recibido. Tipo:', type);

    for (const msg of messages) {
      console.log('📄 Mensaje recibido:', JSON.stringify(msg, null, 2));

      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      console.log(`💬 Texto detectado: "${body}" | Desde: ${from}`);

      const command = body.trim().toLowerCase();

      if (command === '!ping') {
        console.log('🚀 Respondiendo a !ping...');
        await sock.sendMessage(from, { text: '🏓 ¡Pong! El bot está respondiendo.' });
      }

      if (command === '!help' || command === '!menu') {
        await sock.sendMessage(from, {
          text: '📋 *MENÚ:* !ping, !todos, !help\n\n>By Zetix-Unlock-Bot'
        });
      }

      if (command === '!todos' && isGroup) {
        const groupMetadata = await sock.groupMetadata(from);
        const participants = groupMetadata.participants;
        let mentions = participants.map(p => p.id);
        let text = `📣 *ATENCIÓN A TODOS*\n\n` + mentions.map(m => `@${m.split('@')[0]}`).join('\n');
        await sock.sendMessage(from, { text, mentions });
      }
    }
  });
}

connectToWhatsApp();