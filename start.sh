#!/bin/bash

echo "🚀 Verificando dependencias del Bot..."

if [ ! -d "node_modules" ]; then
    echo "📦 Instalando paquetes de Node.js..."
    npm install
fi

echo "🟢 Iniciando el Bot de WhatsApp 24/7..."
npm start
