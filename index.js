const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Base de datos temporal en memoria para advertencias
const warnings = {};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_auth');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot conectado exitosamente a WhatsApp.');
        }
    });

    // -------------------------------------------------------------
    // EVENTO 1: Bienvenida al grupo
    // -------------------------------------------------------------
    sock.ev.on('group-participants.update', async (data) => {
        const { id, participants, action } = data;
        if (action === 'add') {
            for (let user of participants) {
                await sock.sendMessage(id, {
                    text: `👋 ¡Bienvenido/a @${user.split('@')[0]} al grupo!

Por favor lee las reglas y respeta a los miembros.`,
                    mentions: [user]
                });
            }
        }
    });

    // -------------------------------------------------------------
    // EVENTO 2: Procesamiento de mensajes y comandos
    // -------------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const sender = m.key.participant || m.key.remoteJid;

        if (!isGroup) return;

        // --- SISTEMA ANTI-LINK / ANTI-SPAM ---
        const linkRegex = /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/gi;
        if (linkRegex.test(body)) {
            await sock.sendMessage(from, { delete: m.key });
            await sock.sendMessage(from, { 
                text: `⚠️ @${sender.split('@')[0]}, los enlaces no están permitidos en este grupo.`, 
                mentions: [sender] 
            });
            return;
        }

        // --- COMANDO: Invocar al grupo (@todos) ---
        if (body === '!todos' || body === '!invocar') {
            const groupMetadata = await sock.groupMetadata(from);
            const participants = groupMetadata.participants.map(p => p.id);
            
            let text = '📢 *LLAMADO GENERAL AL GRUPO* 📢

';
            participants.forEach(p => text += `@${p.split('@')[0]}
`);

            await sock.sendMessage(from, { text, mentions: participants });
        }

        // --- COMANDO: Servidor Web ---
        if (body === '!server' || body === '!servidor') {
            await sock.sendMessage(from, { text: '🌐 *Servidor Web Oficial:* https://tudominio.com
Status: 🟢 En línea 24/7' });
        }

        // --- COMANDO: Métodos de Pago ---
        if (body === '!pagos' || body === '!pago') {
            const infoPagos = `💳 *MÉTODOS DE PAGO DISPONIBLES*

` +
                              `• *PayPal:* pagos@tudominio.com
` +
                              `• *Transferencia / Pago Móvil:* Solicitar datos por privado
` +
                              `• *Binance / USDT:* USDT-TRC20: \`TU_WALLET_AQUI\`

` +
                              `_Envía el comprobante a un administrador tras realizar el pago._`;
            await sock.sendMessage(from, { text: infoPagos });
        }

        // --- COMANDO: Advertencias (Warn) ---
        if (body.startsWith('!warn')) {
            const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                await sock.sendMessage(from, { text: 'Debes mencionar a un usuario para advertir. Ejemplo: !warn @usuario' });
                return;
            }

            warnings[mentioned] = (warnings[mentioned] || 0) + 1;
            
            if (warnings[mentioned] >= 3) {
                await sock.sendMessage(from, { 
                    text: `🚫 @${mentioned.split('@')[0]} ha acumulado 3 advertencias y será expulsado/a.`, 
                    mentions: [mentioned] 
                });
                await sock.groupParticipantsUpdate(from, [mentioned], 'remove');
                delete warnings[mentioned];
            } else {
                await sock.sendMessage(from, { 
                    text: `⚠️ @${mentioned.split('@')[0]} ha recibido una advertencia. (${warnings[mentioned]}/3)`, 
                    mentions: [mentioned] 
                });
            }
        }

        // --- COMANDO: Quitar Advertencia (Unwarn) ---
        if (body.startsWith('!unwarn')) {
            const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (mentioned && warnings[mentioned]) {
                warnings[mentioned] = Math.max(0, warnings[mentioned] - 1);
                await sock.sendMessage(from, { 
                    text: `✅ Se retiró una advertencia a @${mentioned.split('@')[0]}. Actual: (${warnings[mentioned]}/3)`, 
                    mentions: [mentioned] 
                });
            }
        }

        // --- COMANDO: Expulsión Directa (Ban) ---
        if (body.startsWith('!ban')) {
            const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (mentioned) {
                await sock.groupParticipantsUpdate(from, [mentioned], 'remove');
                await sock.sendMessage(from, { text: `🚪 Usuario expulsado del grupo.` });
            }
        }
    });

    // -------------------------------------------------------------
    // TAREAS PROGRAMADAS (Cron Jobs)
    // -------------------------------------------------------------
    // Buenos días (8:00 AM)
    cron.schedule('0 8 * * *', async () => {
        const groupId = 'ID_DEL_GRUPO@g.us'; // Coloca aquí el ID de tu grupo
        await sock.sendMessage(groupId, { text: '☀️ ¡Buenos días a todos! Que tengan un excelente día.' });
    });

    // Buenas noches y cierre de grupo (10:00 PM)
    cron.schedule('0 22 * * *', async () => {
        const groupId = 'ID_DEL_GRUPO@g.us';
        await sock.sendMessage(groupId, { text: '🌙 ¡Buenas noches! El grupo se cerrará hasta mañana.' });
        await sock.groupSettingUpdate(groupId, 'announcement');
    });

    // Apertura de grupo (7:00 AM)
    cron.schedule('0 7 * * *', async () => {
        const groupId = 'ID_DEL_GRUPO@g.us';
        await sock.groupSettingUpdate(groupId, 'not_announcement');
        await sock.sendMessage(groupId, { text: '🔓 El grupo ha sido abierto. ¡Que tengan feliz día!' });
    });
}

// Servidor Web HTTP para hosting 24/7
app.get('/', (req, res) => {
    res.send('✅ Servidor del Bot de WhatsApp activo 24/7.');
});

app.listen(PORT, () => {
    console.log(`🌐 Servidor Web activo en el puerto ${PORT}`);
    startBot();
});
