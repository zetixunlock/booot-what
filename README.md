# WhatsApp Bot 24/7 para Grupos

Bot completo de WhatsApp con panel de control web Express, preparado para despliegue en la nube (Render, Railway, Koyeb, etc.).

## Funcionalidades
- 🟢 **Servidor Web Activo 24/7** (`Express`)
- 👋 **Mensaje de Bienvenida** a nuevos miembros
- 🚫 **Anti-Link / Anti-Spam** (elimina mensajes con enlaces automáticamente)
- 📢 **Invocación General** (`!todos` / `!invocar`)
- 🌐 **Información del Servidor** (`!server`)
- 💳 **Métodos de Pago** (`!pagos`)
- ⚠️ **Sistema de Advertencias y Bans** (`!warn`, `!unwarn`, `!ban`)
- ⏰ **Apertura y Cierre Automático del Grupo** + Mensajes de Buenos días / Buenas noches (cron jobs)

## Ejecución rápida con Script Bash (`start.sh`)

1. Otorga permisos de ejecución al script:
   ```bash
   chmod +x start.sh
   ```
2. Ejecuta el script:
   ```bash
   ./start.sh
   ```

El script verificará si los módulos están instalados e iniciará automáticamente el servidor del bot.
