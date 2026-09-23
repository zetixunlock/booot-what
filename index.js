const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Número del bot con código de país de Venezuela (58)
const BOT_PHONE_NUMBER = "584223300969";

let pairingCode = '';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot activo y en línea.');
});

app.get('/qr', (req, res) => {
  if (!pairingCode) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
        <h2>⌛ Generando código de vinculación o bot ya conectado...</h2>
        <p>Si la página no carga el código de inmediato, recárgala en 5 segundos.</p>
      </div>
    `);
  }
  res.send(`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0b141a;color:#fff;font-family:sans-serif;">
      <h2>📲 CÓDIGO DE VINCULACIÓN WHATSAPP</h2>
      <h1 style="font-size:48px;letter-spacing:6px;background:#202c33;padding:15px 30px;border-radius:10px;color:#00a884;">${pairingCode}</h1>
      <p style="color:#8696a0;">Abre WhatsApp > Dispositivos vinculados > Vincular con el número de teléfono</p>
    </div>
  `);
});

app.listen(port, () => console.log(`🌐 Servidor corriendo en puerto ${port}`));

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  // Generar código de 8 dígitos si no hay sesión registrada
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        pairingCode = code;
        console.log(`🔑 CÓDIGO DE EMPAREJAMIENTO GENERADO: ${pairingCode}`);
      } catch (err) {
        console.error('Error generando el código de vinculación:', err);
      }
    }, 4000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      pairingCode = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠️ Conexión cerrada. Código:', statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('🧹 Limpiando sesión expirada...');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
      }

      console.log('🔄 Reintentando conexión en 3 segundos...');
      setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      pairingCode = '';
      console.log('==============================================');
      console.log('✅ ¡BOT CONECTADO CON ÉXITO Y ESCUCHANDO CHATS!');
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
          console.log('⚡ Respondiendo !ping...');
          await sock.sendMessage(from, { text: '🏓 *¡Pong!* El bot está activo y respondiendo.\n\n>By Zetix-Unlock-Bot' });
        }

        if (command === '!help' || command === '!menu') {
          await sock.sendMessage(from, {
            text: '📋 *MENÚ DE COMANDOS:*\n\n' +
                  '🔹 *!ping* - Probar estado\n' +
                  '🔹 *!todos* - Mencionar miembros (grupos)\n' +
                  '🔹 *!help* - Menú de ayuda\n\n' +
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