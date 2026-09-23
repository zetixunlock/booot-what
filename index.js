const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Servidor Express para mantener la app activa en Render
app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot está en línea y funcionando 24/7!');
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
    printQRInTerminal: false // Desactivamos el QR visual
  });

  sock.ev.on('creds.update', saveCreds);

  // Sistema de Pairing Code con tu número de teléfono
  if (!sock.authState.creds.registered) {
    const phoneNumber = "584223300969"; // Número configurado
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('\n==================================================');
        console.log(`🔑 CÓDIGO DE VINCULACIÓN DE WHATSAPP: ${code}`);
        console.log('==================================================\n');
      } catch (error) {
        console.error('Error al generar el código de vinculación:', error);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        '⚠️ Conexión cerrada debido a:',
        lastDisconnect?.error,
        ', reconectando:',
        shouldReconnect
      );
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ ¡Conexión establecida con éxito con WhatsApp!');
    }
  });

  // Mensaje de bienvenida con mención
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update;
      if (action === 'add') {
        const groupMetadata = await sock.groupMetadata(id);
        const groupName = groupMetadata.subject;

        for (const num of participants) {
          const welcomeMessage = `✨ *¡BIENVENIDO/A AL GRUPO!* ✨\n\n` +
            `Hola @${num.split('@')[0]} 👋, nos alegra tenerte en *${groupName}* 🎉.\n\n` +
            `Por favor respeta las reglas de la comunidad y disfruta de tu estadía. 🤝\n\n` +
            `>By Zetix-Unlock-Bot`;

          await sock.sendMessage(id, {
            text: welcomeMessage,
            mentions: [num]
          });
        }
      }
    } catch (err) {
      console.error('Error en bienvenida de grupo:', err);
    }
  });

  // Procesador de mensajes
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      const command = body.trim().toLowerCase();

      // Comando !ping
      if (command === '!ping') {
        await sock.sendMessage(from, {
          text: `🏓 *¡Pong!* El bot está activo y respondiendo a toda velocidad. ⚡\n\n>By Zetix-Unlock-Bot`
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

        text += `\n💬 *Atención a todos los miembros del grupo.*\n\n>By Zetix-Unlock-Bot`;

        await sock.sendMessage(from, { text, mentions });
      }

      // Anti-link
      if (isGroup && (body.includes('chat.whatsapp.com/') || body.includes('wa.me/'))) {
        await sock.sendMessage(from, {
          text: `⚠️ *¡ALERTA DE ANTI-LINK!* ⚠️\n\nEstá prohibido enviar enlaces de WhatsApp en este grupo. 🚫\n\n>By Zetix-Unlock-Bot`
        });
        await sock.sendMessage(from, { delete: msg.key });
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