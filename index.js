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
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

let currentQR = '';
let sock = null;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const WARNINGS_FILE = path.join(__dirname, 'warnings.json');
const SETTINGS_FILE = path.join(__dirname, 'group_settings.json');
const RULES_FILE = path.join(__dirname, 'rules.json');
const LEVELS_FILE = path.join(__dirname, 'levels.json');
const ACTIVITY_FILE = path.join(__dirname, 'activity.json');

// ==================== DATOS DEL NEGOCIO ====================
const WEB_URL = 'https://zetix-unlock.onrender.com';
const PAGO_INFO = 'Binance Pay: 1249282279\nAlias: Zetix Unlock';
const FOOTER = '\n\n> Zetix-Unlock';

// ==================== ANTIFLOOD (en memoria) ====================
const FLOOD_WINDOW_MS = 8000; // ventana de tiempo
const FLOOD_MAX_MSGS = 5;     // mensajes permitidos dentro de la ventana
const floodTracker = {};      // { groupId: { userId: [timestamps] } }

function isFlooding(groupId, userId) {
  const now = Date.now();
  if (!floodTracker[groupId]) floodTracker[groupId] = {};
  if (!floodTracker[groupId][userId]) floodTracker[groupId][userId] = [];

  const timestamps = floodTracker[groupId][userId].filter(t => now - t < FLOOD_WINDOW_MS);
  timestamps.push(now);
  floodTracker[groupId][userId] = timestamps;

  return timestamps.length > FLOOD_MAX_MSGS;
}

// ==================== PERSISTENCIA SIMPLE (JSON) ====================
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`⚠️ No se pudo leer ${file}:`, e.message);
  }
  return fallback;
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`⚠️ No se pudo guardar ${file}:`, e.message);
  }
}

let warnings = loadJSON(WARNINGS_FILE, {});       // { groupId: { userId: count } }
let groupSettings = loadJSON(SETTINGS_FILE, {});  // { groupId: { antilink: true } }
let groupRules = loadJSON(RULES_FILE, {});        // { groupId: "texto de reglas" }
let levels = loadJSON(LEVELS_FILE, {});           // { groupId: { userId: messageCount } }
let activity = loadJSON(ACTIVITY_FILE, {});       // { groupId: { userId: lastMessageTimestamp } }

function getGroupSettings(groupId) {
  if (!groupSettings[groupId]) {
    groupSettings[groupId] = { antilink: true };
    saveJSON(SETTINGS_FILE, groupSettings);
  }
  return groupSettings[groupId];
}

function addWarning(groupId, userId) {
  if (!warnings[groupId]) warnings[groupId] = {};
  warnings[groupId][userId] = (warnings[groupId][userId] || 0) + 1;
  saveJSON(WARNINGS_FILE, warnings);
  return warnings[groupId][userId];
}

function getWarnings(groupId, userId) {
  return warnings?.[groupId]?.[userId] || 0;
}

async function kickUser(groupId, userId, reason) {
  try {
    await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
    await sendWithRetry(groupId, { text: `👢 @${userId.split('@')[0]} fue expulsado (${reason}).${FOOTER}`, mentions: [userId] });
  } catch (e) {
    console.log('⚠️ No se pudo expulsar (¿el bot es admin?):', e.message);
  }
}

// ==================== ACTIVIDAD (para limpieza de inactivos) ====================
function markActive(groupId, userId) {
  if (!activity[groupId]) activity[groupId] = {};
  activity[groupId][userId] = Date.now();
  saveJSON(ACTIVITY_FILE, activity);
}

function getLastActive(groupId, userId) {
  return activity?.[groupId]?.[userId] || null;
}

// ==================== SISTEMA DE NIVELES / REPUTACIÓN ====================
const LEVEL_TIERS = [
  { min: 0, title: '🌱 Novato' },
  { min: 20, title: '💬 Activo' },
  { min: 50, title: '🔥 Veterano' },
  { min: 100, title: '⭐ Experto' },
  { min: 250, title: '👑 Leyenda' }
];

function getLevelInfo(count) {
  let tier = LEVEL_TIERS[0];
  for (const t of LEVEL_TIERS) if (count >= t.min) tier = t;
  const levelNumber = Math.floor(count / 20) + 1;
  return { levelNumber, title: tier.title };
}

// Suma participación y devuelve si el usuario acaba de subir de nivel
function addParticipation(groupId, userId) {
  if (!levels[groupId]) levels[groupId] = {};
  const before = levels[groupId][userId] || 0;
  const after = before + 1;
  levels[groupId][userId] = after;
  saveJSON(LEVELS_FILE, levels);

  const prevLevel = getLevelInfo(before).levelNumber;
  const newLevel = getLevelInfo(after).levelNumber;
  return { count: after, leveledUp: newLevel > prevLevel, levelInfo: getLevelInfo(after) };
}

function getParticipation(groupId, userId) {
  return levels?.[groupId]?.[userId] || 0;
}

function getTopParticipants(groupId, limit = 5) {
  const entries = Object.entries(levels?.[groupId] || {});
  return entries.sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// ==================== SERVIDOR WEB (QR / status) ====================
app.get('/', (req, res) => {
  res.send('🔓 Zetix-Unlock-Bot activo.');
});

app.get('/reset-session', (req, res) => {
  try {
    if (sock) {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    }
    currentQR = '';
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    res.send('<h2 style="color:green;text-align:center;margin-top:50px;">✔ Sesión eliminada. Redirigiendo en 3 segundos...</h2><script>setTimeout(()=>{window.location.href="/qr"},3000)</script>');
    setTimeout(connectToWhatsApp, 1500);
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2>⏳ Esperando código QR o bot ya conectado...</h2>
        <p>Si la consola no avanza, haz <a href="/reset-session">clic aquí para forzar el reinicio</a></p>
      </div>
    `);
  }
  try {
    const qrImageUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0b141a;color:#fff;font-family:sans-serif;">
        <h2>📱 ESCANEA ESTE CÓDIGO CON WHATSAPP</h2>
        <img src="${qrImageUrl}" style="border:10px solid #fff;border-radius:12px;max-width:300px;" />
        <br/><br/>
        <a href="/reset-session" style="color:#ff6b6b;text-decoration:none;border:1px solid #ff6b6b;padding:10px;border-radius:5px;">⚠ Generar un nuevo código</a>
      </div>
    `);
  } catch (err) {
    res.status(500).send('Error generando QR');
  }
});

app.listen(port, () => console.log(`🌐 Servidor corriendo en puerto ${port}`));

// ==================== UTILIDADES DE MENSAJE ====================
function extractMessageText(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.conversation ||
    ''
  );
}

const LINK_REGEX = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)/i;

async function sendWithRetry(jid, content, retries = 3) {
  if (jid.endsWith('@g.us')) {
    try { await sock.groupMetadata(jid); } catch (e) {}
  }

  const isLid = jid.includes('@lid');
  const attempts = isLid ? 2 : retries;

  for (let i = 0; i < attempts; i++) {
    try {
      return await sock.sendMessage(jid, content);
    } catch (err) {
      const isSessionError = /no sessions/i.test(err.message);
      if (isLid && isSessionError) {
        console.log(`⚠️ Intento ${i + 1}/${attempts} falló por identidad @lid sin sesión disponible.`);
      } else {
        console.log(`⚠️ Intento ${i + 1}/${attempts} de envío falló: ${err.message}. Reintentando...`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.log('❌ No se pudo enviar el mensaje tras varios intentos.');
}

// Revisa si el remitente es admin/superadmin del grupo
async function isGroupAdmin(groupId, participantId) {
  try {
    const metadata = await sock.groupMetadata(groupId);
    const participant = metadata.participants.find(p => p.id === participantId);
    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch (e) {
    return false;
  }
}

// ==================== CONEXIÓN ====================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    browser: ["Zetix Bot", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📱 CÓDIGO QR LISTO EN /qr');
    }

    if (connection === 'close') {
      currentQR = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠ Conexión cerrada. Código de error:', statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('✘ Usuario desconectado. Limpiando credenciales...');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
      }

      console.log('🔄 Reintentando conexión en 3 segundos...');
      setTimeout(connectToWhatsApp, 3000);

    } else if (connection === 'open') {
      currentQR = '';
      console.log('=====================================================');
      console.log('✅ ¡CONEXIÓN EXITOSA! EL BOT ESTÁ LISTO Y RESPONDIENDO.');
      console.log('=====================================================');
      setupScheduledMessages();
    }
  });

  // ==================== BIENVENIDA / DESPEDIDA AUTOMÁTICA ====================
  sock.ev.on('group-participants.update', async (update) => {
    const { id: groupId, participants, action } = update;
    try {
      if (action === 'add') {
        for (const userId of participants) {
          markActive(groupId, userId); // le da margen antes de ser marcado "inactivo"
          await sendWithRetry(groupId, {
            text: `👋 ¡Bienvenido/a @${userId.split('@')[0]} al grupo!\nEscribe *!reglas* para ver las normas.${FOOTER}`,
            mentions: [userId]
          });
        }
      } else if (action === 'remove') {
        for (const userId of participants) {
          await sendWithRetry(groupId, {
            text: `😢 @${userId.split('@')[0]} salió del grupo. ¡Hasta pronto!${FOOTER}`,
            mentions: [userId]
          });
        }
      }
    } catch (e) {
      console.log('⚠️ Error en bienvenida/despedida:', e.message);
    }
  });

  // ==================== MENSAJES ENTRANTES ====================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const body = extractMessageText(msg);

        if (!body || msg.key.fromMe || body.includes('Zetix-Unlock')) continue;

        console.log(`📩 Recibido de ${sender}${isGroup ? ` (grupo ${from})` : ''}: "${body}"`);

        const command = body.trim().toLowerCase();
        const admin = isGroup ? await isGroupAdmin(from, sender) : false;

        // Cualquier mensaje que llegue cuenta como actividad (para el comando de limpieza)
        if (isGroup) markActive(from, sender);

        // ---------- ANTILINK ----------
        if (isGroup && getGroupSettings(from).antilink && LINK_REGEX.test(body) && !admin) {
          try { await sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
          const count = addWarning(from, sender);
          await sendWithRetry(from, {
            text: `🚫 @${sender.split('@')[0]} tu mensaje contenía un link y fue eliminado.\nAdvertencia ${count}/3.${FOOTER}`,
            mentions: [sender]
          });
          if (count >= 3) await kickUser(from, sender, 'links no permitidos');
          continue;
        }

        // ---------- ANTIFLOOD ----------
        if (isGroup && !admin && isFlooding(from, sender)) {
          try { await sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
          const count = addWarning(from, sender);
          await sendWithRetry(from, {
            text: `🚫 @${sender.split('@')[0]} estás enviando mensajes muy rápido (flood).\nAdvertencia ${count}/3.${FOOTER}`,
            mentions: [sender]
          });
          if (count >= 3) await kickUser(from, sender, 'flood de mensajes');
          continue;
        }

        // ---------- REPUTACIÓN: sumar participación por mensaje normal (no comandos) ----------
        if (isGroup && !command.startsWith('!')) {
          const { leveledUp, levelInfo } = addParticipation(from, sender);
          if (leveledUp) {
            await sendWithRetry(from, {
              text: `🎉 ¡Felicidades @${sender.split('@')[0]}! Subiste a *Nivel ${levelInfo.levelNumber} — ${levelInfo.title}* por tu participación activa.${FOOTER}`,
              mentions: [sender]
            });
          }
        }

        // Comandos públicos (no requieren admin)
        if (command === '!web' || command === '!server') {
          await sendWithRetry(from, { text: `🌐 Nuestro servidor/web:\n${WEB_URL}${FOOTER}` });
          continue;
        }
        if (command === '!pago' || command === '!pagos' || command === '!metododepago') {
          await sendWithRetry(from, { text: `💳 *Métodos de pago:*\n\n${PAGO_INFO}${FOOTER}` });
          continue;
        }
        if (command === '!nivel' && isGroup) {
          const count = getParticipation(from, sender);
          const { levelNumber, title } = getLevelInfo(count);
          await sendWithRetry(from, {
            text: `📊 @${sender.split('@')[0]}\nNivel ${levelNumber} — ${title}\nMensajes: ${count}${FOOTER}`,
            mentions: [sender]
          });
          continue;
        }
        if (command === '!ranking' && isGroup) {
          const top = getTopParticipants(from, 5);
          if (top.length === 0) {
            await sendWithRetry(from, { text: `Todavía no hay datos de participación en este grupo.${FOOTER}` });
          } else {
            const lines = top.map(([userId, count], i) => {
              const { levelNumber, title } = getLevelInfo(count);
              return `${i + 1}. @${userId.split('@')[0]} — Nivel ${levelNumber} (${title}) — ${count} msjs`;
            });
            await sendWithRetry(from, {
              text: `🏆 *Ranking de participación:*\n\n${lines.join('\n')}${FOOTER}`,
              mentions: top.map(([userId]) => userId)
            });
          }
          continue;
        }

        // El resto de comandos solo funcionan dentro de grupos y solo para admins
        const isCommand = command.startsWith('!');
        if (!isCommand) continue;
        if (!isGroup || !admin) {
          if (isGroup) {
            await sendWithRetry(from, { text: `⛔ Ese comando es solo para administradores.${FOOTER}` });
          }
          continue;
        }

        // ---------- COMANDOS DE ADMIN ----------
        if (command === '!ping') {
          await sendWithRetry(from, { text: `🏓 *¡Pong!* El bot está activo y funcionando.${FOOTER}` });

        } else if (command === '!info') {
          await sendWithRetry(from, {
            text: `🤖 *Zetix-Unlock-Bot*\n\n` +
              `Públicos:\n` +
              `!web / !server — Link del servidor\n` +
              `!pago — Métodos de pago\n` +
              `!nivel — Tu nivel de participación\n` +
              `!ranking — Top 5 más activos\n\n` +
              `Solo admins:\n` +
              `!ping — Verifica que el bot esté activo\n` +
              `!info — Muestra esta información\n` +
              `!despertar — Menciona a todos los miembros\n` +
              `!todos <mensaje> — Menciona a todos con un mensaje\n` +
              `!abrirgrupo / !cerrargrupo — Abre o cierra el grupo\n` +
              `!antilink on/off — Activa o desactiva el antilink\n` +
              `!advertencias @usuario — Consulta advertencias\n` +
              `!reglas — Muestra las reglas\n` +
              `!reglas <texto> — Define las reglas del grupo\n` +
              `!limpiar <días> — Expulsa miembros inactivos (por defecto 30 días)${FOOTER}`
          });

        } else if (command === '!despertar') {
          const metadata = await sock.groupMetadata(from);
          const participants = metadata.participants.map(p => p.id);
          await sendWithRetry(from, {
            text: `⏰ ¡Despierten! Es hora de activarse en el grupo.${FOOTER}`,
            mentions: participants
          });

        } else if (command.startsWith('!todos')) {
          const customText = body.trim().slice('!todos'.length).trim();
          const metadata = await sock.groupMetadata(from);
          const participants = metadata.participants.map(p => p.id);
          const mentionText = participants.map(p => `@${p.split('@')[0]}`).join(' ');
          await sendWithRetry(from, {
            text: `📢 ${customText || 'Mención para todos los miembros'}\n\n${mentionText}${FOOTER}`,
            mentions: participants
          });

        } else if (command === '!abrirgrupo') {
          try {
            await sock.groupSettingUpdate(from, 'not_announcement');
            await sendWithRetry(from, { text: `🔓 Grupo abierto. Todos pueden escribir.${FOOTER}` });
          } catch (e) {
            console.log('⚠️ No se pudo abrir el grupo:', e.message);
          }

        } else if (command === '!cerrargrupo') {
          try {
            await sock.groupSettingUpdate(from, 'announcement');
            await sendWithRetry(from, { text: `🔒 Grupo cerrado. Solo los admins pueden escribir.${FOOTER}` });
          } catch (e) {
            console.log('⚠️ No se pudo cerrar el grupo:', e.message);
          }

        } else if (command === '!antilink on' || command === '!antilink off') {
          const enable = command.endsWith('on');
          getGroupSettings(from).antilink = enable;
          saveJSON(SETTINGS_FILE, groupSettings);
          await sendWithRetry(from, { text: `🛡️ Antilink ${enable ? 'activado' : 'desactivado'}.${FOOTER}` });

        } else if (command.startsWith('!advertencias')) {
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
          if (!mentioned || mentioned.length === 0) {
            await sendWithRetry(from, { text: `Usa: !advertencias @usuario${FOOTER}` });
            continue;
          }
          const target = mentioned[0];
          const count = getWarnings(from, target);
          await sendWithRetry(from, {
            text: `⚠️ @${target.split('@')[0]} tiene ${count}/3 advertencias.${FOOTER}`,
            mentions: [target]
          });

        } else if (command.startsWith('!reglas')) {
          const newRules = body.trim().slice('!reglas'.length).trim();
          if (newRules) {
            groupRules[from] = newRules;
            saveJSON(RULES_FILE, groupRules);
            await sendWithRetry(from, { text: `✅ Reglas actualizadas.${FOOTER}` });
          } else {
            const current = groupRules[from];
            await sendWithRetry(from, {
              text: current
                ? `📋 *Reglas del grupo:*\n\n${current}${FOOTER}`
                : `Este grupo aún no tiene reglas definidas. Usa: !reglas <texto> para configurarlas.${FOOTER}`
            });
          }

        } else if (command.startsWith('!limpiar')) {
          const arg = body.trim().slice('!limpiar'.length).trim();
          const days = parseInt(arg, 10) || 30;
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

          try {
            const metadata = await sock.groupMetadata(from);
            const inactive = [];

            for (const p of metadata.participants) {
              // Nunca expulsar admins en la limpieza automática
              if (p.admin === 'admin' || p.admin === 'superadmin') continue;

              const lastActive = getLastActive(from, p.id);
              // Sin registro de actividad (nunca escribió desde que el bot lleva historial) o inactivo hace más de "days"
              if (!lastActive || lastActive < cutoff) {
                inactive.push(p.id);
              }
            }

            if (inactive.length === 0) {
              await sendWithRetry(from, { text: `✅ No hay miembros inactivos por más de ${days} días.${FOOTER}` });
              continue;
            }

            await sendWithRetry(from, {
              text: `🧹 Expulsando ${inactive.length} miembro(s) inactivo(s) por más de ${days} días...${FOOTER}`
            });

            for (const userId of inactive) {
              try {
                await sock.groupParticipantsUpdate(from, [userId], 'remove');
                await new Promise(r => setTimeout(r, 1500)); // evitar rate-limit de WhatsApp
              } catch (e) {
                console.log(`⚠️ No se pudo expulsar a ${userId}:`, e.message);
              }
            }

            await sendWithRetry(from, { text: `✅ Limpieza completada. ${inactive.length} miembro(s) expulsado(s).${FOOTER}` });
          } catch (e) {
            console.log('⚠️ Error en !limpiar:', e.message);
            await sendWithRetry(from, { text: `❌ Ocurrió un error al hacer la limpieza: ${e.message}${FOOTER}` });
          }
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });
}

// ==================== MENSAJES PROGRAMADOS (buenos días / buenas noches) ====================
let scheduledJobsCreated = false;
function setupScheduledMessages() {
  if (scheduledJobsCreated) return;
  scheduledJobsCreated = true;

  const sendToAllGroups = async (text) => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const groupId of Object.keys(groups)) {
        await sendWithRetry(groupId, { text });
      }
    } catch (e) {
      console.log('⚠️ No se pudo enviar mensaje programado:', e.message);
    }
  };

  // 7:00 AM hora de Venezuela
  cron.schedule('0 7 * * *', () => {
    sendToAllGroups(`☀️ ¡Buenos días a todos! Que tengan un excelente día.${FOOTER}`);
  }, { timezone: 'America/Caracas' });

  // 9:00 PM hora de Venezuela
  cron.schedule('0 21 * * *', () => {
    sendToAllGroups(`🌙 ¡Buenas noches! Que descansen.${FOOTER}`);
  }, { timezone: 'America/Caracas' });

  console.log('⏰ Mensajes programados de buenos días/buenas noches configurados (America/Caracas).');
}

connectToWhatsApp();
