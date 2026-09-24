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

const app = express();
const port = process.env.PORT || 3000;

let currentQR = '';
let sock = null;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

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

// Reintenta el envío de un mensaje si la sesión de Signal aún no está lista.
// Para grupos, primero fuerza la carga de metadata (participantes y claves)
// ya que sin eso Baileys no puede cifrar el mensaje y falla con "No sessions".
async function sendWithRetry(jid, content, retries = 3) {
  if (jid.endsWith('@g.us')) {
    try {
      await sock.groupMetadata(jid);
    } catch (e) {
      console.log('⚠️ No se pudo obtener metadata del grupo:', e.message);
    }
  }

  for (let i = 0; i < retries; i++) {
    try {
      return await sock.sendMessage(jid, content);
    } catch (err) {
      console.log(`⚠️ Intento ${i + 1} de envío falló: ${err.message}. Reintentando...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.log('❌ No se pudo enviar el mensaje tras varios intentos.');
}

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

      // Si el cierre fue por desconexión del usuario, borrar credenciales
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
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const body = extractMessageText(msg);

        // Omitir si no hay texto o es el propio bot
        if (!body || msg.key.fromMe || body.includes('>By Zetix-Unlock-Bot')) continue;

        console.log(`📩 Recibido de ${from}: "${body}"`);

        const command = body.trim().toLowerCase();

        if (command === '!ping') {
          console.log('⚡ Ejecutando !ping...');
          await sendWithRetry(from, { text: '🏓 *¡Pong!* El bot está activo y responde en Render.\n\n>By Zetix-Unlock-Bot' });
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });
}

connectToWhatsApp();
