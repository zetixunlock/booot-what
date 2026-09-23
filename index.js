const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Zetix-Unlock-Bot está en línea y funcionando 24/7!');
});

app.listen(port, () => {
  console.log(`🌐 Servidor corriendo en el puerto ${port}`);
});

async function connectToWhatsApp() {
  const authFolder = path.join(__dirname, 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"] // Emula un navegador web estándar
  });

  sock.ev.on('creds.update', saveCreds);

  // Solicitar Código de Vinculación si no está registrado
  if (!sock.authState.creds.registered) {
    const phoneNumber = "584223300969"; 
    
    // Esperamos 6 segundos a que el socket se estabilice
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('\n==================================================');
        console.log(`🔑 CÓDIGO DE VINCULACIÓN DE WHATSAPP: ${code}`);
        console.log('==================================================\n');
      } catch (error) {
        console.error('Error al generar el código de vinculación:', error);
      }
    }, 6000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log('⚠️ Conexión cerrada. Reconectando:', shouldReconnect);
      
      // Si fue desvinculado o expiró de forma crítica, limpia las credenciales
      if (statusCode === DisconnectReason.loggedOut) {
        if (fs.existsSync(authFolder)) {
          fs.rmSync(authFolder, { recursive: true, force: true });
        }
      }

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ ¡Conexión establecida con éxito con WhatsApp!');
    }
  });

  // Bienvenida a grupos
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

          await sock.sendMessage(id, { text: welcomeMessage, mentions: [num] });
        }
      }
    } catch (err) {
      console.error('Error en bienvenida de grupo:', err);
    }
  });

  // Mensajes y Comandos
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const command = body.trim().toLowerCase();

      if (command === '!ping') {
        await sock.sendMessage(from, {
          text: `🏓 *¡Pong!* El bot está activo y respondiendo a toda velocidad. ⚡\n\n>By Zetix-Unlock-Bot`
        });
      }

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