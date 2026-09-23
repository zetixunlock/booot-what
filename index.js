const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');

const app = express();
const port = process.env.PORT || 3000;

// Servidor Express básico para mantener Render activo
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
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 Escanea el siguiente código QR con tu WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

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

  // Evento cuando se unen nuevos miembros al grupo
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update;
      
      // Si entra un nuevo participante
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

  // Procesador de mensajes e interacciones
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

      // Comando de prueba /ping
      if (command === '!ping') {
        await sock.sendMessage(from, {
          text: `🏓 *¡Pong!* El bot está activo y respondiendo a toda velocidad. ⚡\n\n>By Zetix-Unlock-Bot`
        });
      }

      // Comando para llamar a todos los miembros (!todos)
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

      // Sistema Anti-Link para grupos
      if (isGroup && (body.includes('chat.whatsapp.com/') || body.includes('wa.me/'))) {
        await sock.sendMessage(from, {
          text: `⚠️ *¡ALERTA DE ANTI-LINK!* ⚠️\n\nEstá prohibido enviar enlaces de WhatsApp en este grupo. 🚫\n\n>By Zetix-Unlock-Bot`
        });
        // Si el bot es admin, puedes activar eliminar el mensaje
        await sock.sendMessage(from, { delete: msg.key });
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

  // Tarea programada opcional cada día a las 9:00 AM (Ejemplo)
  cron.schedule('0 9 * * *', () => {
    console.log('⏰ Ejecutando tarea automatizada diaria...');
  });
}

connectToWhatsApp();