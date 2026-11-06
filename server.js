// server.js - Versión Optimizada para Captura de Eventos en Tiempo Real
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Servir archivos estáticos como index.html
app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

let pagosBD = [];
let smsBancoBD = [];
let sockWhatsApp = null;
let ultimoQrGenerado = "";

async function iniciarWhatsApp() {
    console.log("🔄 Iniciando conexión con WhatsApp en Render...");
    
    const { state, saveCreds } = await useMultiFileAuthState('sesion_whatsapp');

    sockWhatsApp = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false,
        markOnlineOnConnect: true
    });

    sockWhatsApp.ev.on('creds.update', saveCreds);

    sockWhatsApp.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            ultimoQrGenerado = qr;
            console.log("\n========================================");
            console.log("📱 NUEVO CÓDIGO QR GENERADO");
            console.log("Entra a https://validador-bdv-bot.onrender.com/qr para verlo en grande.");
            console.log("========================================\n");
            
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const razon = lastDisconnect?.error?.output?.statusCode;
            const debeReconectar = razon !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada (Razón: ${razon}). Reconectando en 5 segundos...`);
            if (debeReconectar) {
                setTimeout(() => iniciarWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ ¡WhatsApp vinculado y listo en la nube!\n');
            ultimoQrGenerado = "";
        }
    });

    sockWhatsApp.ev.on('messages.upsert', async (m) => {
        console.log("📥 [EVENTO WHATSAPP]: Mensaje recibido desde el servidor.");
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remitente = msg.key.remoteJid;
        let nombreCliente = msg.pushName || "Cliente WhatsApp";
        const telefonoLimpio = remitente.split('@')[0].replace(/[^0-9]/g, '');

        let mensajeContenido = msg.message;
        if (mensajeContenido.ephemeralMessage) mensajeContenido = mensajeContenido.ephemeralMessage.message;
        if (mensajeContenido.viewOnceMessage) mensajeContenido = mensajeContenido.viewOnceMessage.message;
        if (mensajeContenido.viewOnceMessageV2) mensajeContenido = mensajeContenido.viewOnceMessageV2.message;

        const esImagen = mensajeContenido.imageMessage;
        const textoPlano = mensajeContenido.conversation || mensajeContenido.extendedTextMessage?.text;

        console.log(`💬 De: ${nombreCliente} (${telefonoLimpio}) | ¿Es imagen?: ${!!esImagen} | Texto: ${textoPlano || 'Ninguno'}`);

        if (esImagen) {
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: undefined, reuploadRequest: sockWhatsApp.updateMediaMessage }
                );

                const nombreArchivo = `comprobante_${Date.now()}.jpg`;
                const rutaCompleta = path.join(uploadDir, nombreArchivo);
                fs.writeFileSync(rutaCompleta, buffer);

                await sockWhatsApp.sendMessage(remitente, { 
                    text: `¡Hola ${nombreCliente}! 👋 Comprobante recibido. Procesando validación...` 
                });

                pagosBD.unshift({
                    id: Date.now(),
                    cliente: nombreCliente,
                    telefono: `+${telefonoLimpio}`,
                    ref: "PENDIENTE_" + Date.now().toString().slice(-4),
                    monto: 0.00,
                    banco: "Banco de Venezuela",
                    estado: "pendiente",
                    fecha: new Date().toLocaleTimeString(),
                    remitenteJid: remitente,
                    imagen: nombreArchivo
                });
                console.log("✅ Comprobante guardado en la base de datos temporal del bot.");
            } catch (error) {
                console.error("❌ Error al descargar imagen:", error);
            }
        }
    });
}

iniciarWhatsApp();

// Ruta web para ver el Código QR
app.get('/qr', async (req, res) => {
    if (!ultimoQrGenerado) {
        return res.send(`
            <div style="text-align:center; font-family:Arial; padding:40px;">
                <h2 style="color:green;">✅ ¡WhatsApp ya está vinculado correctamente!</h2>
                <p>Puedes cerrar esta ventana y usar tu panel principal.</p>
            </div>
        `);
    }
    try {
        const urlImagenQr = await qrcode.toDataURL(ultimoQrGenerado);
        res.send(`
            <div style="text-align:center; font-family:Arial; padding:20px; background:#f0f8ff; min-height:100vh;">
                <h2>📱 Escanea este Código QR con tu Teléfono</h2>
                <p>Abre WhatsApp → Dispositivos Vinculados → Vincular un dispositivo</p>
                <img src="${urlImagenQr}" alt="QR" style="max-width:400px; border:4px solid #0066cc; border-radius:12px; padding:10px; background:white;">
                <p style="color:#666;">Si el código expira, recarga esta página en 10 segundos.</p>
            </div>
        `);
    } catch (err) {
        res.status(500).send("Error generando la imagen QR.");
    }
});

// Webhook para recibir notificaciones SMS del BDV
app.post('/webhook/sms-banco', async (req, res) => {
    try {
        const { texto } = req.body;
        console.log(`\n🔔 [Notificación BDV]: ${texto}`);

        // Guardar el SMS recibido
        smsBancoBD.unshift({
            id: Date.now(),
            texto: texto,
            fecha: new Date().toLocaleString()
        });

        let referenciaEncontrada = "";
        let montoEncontrado = 0.00;

        if (texto && texto !== "{notification_text}") {
            const matchRef = texto.match(/(?:ref|referencia)[^\d]*(\d{4,8})/i) || texto.match(/#(\d{4,8})/);
            if (matchRef) referenciaEncontrada = matchRef[1];

            const montosPosibles = texto.match(/\d+[\.,]\d{2}/g);
            if (montosPosibles && montosPosibles.length > 0) {
                let montoStr = montosPosibles[montosPosibles.length - 1].replace('.', '').replace(',', '.');
                montoEncontrado = parseFloat(montoStr) || 0.00;
            }
        }

        // Cruce automático: si hay referencia válida y monto, buscar pago pendiente coincidente
        if (!referenciaEncontrada || referenciaEncontrada === "0000" || montoEncontrado === 0) {
            return res.json({ status: "info", message: "Datos insuficientes para cruce automático" });
        }

        // Buscar pago pendiente con la misma referencia
        const pagoCoincidente = pagosBD.find(p => 
            p.estado === "pendiente" && 
            (p.ref === referenciaEncontrada || p.ref === "PENDIENTE_" + referenciaEncontrada)
        );

        if (pagoCoincidente) {
            pagoCoincidente.estado = "aprobado";
            pagoCoincidente.monto = montoEncontrado;
            pagoCoincidente.fechaAprobacion = new Date().toLocaleString();
            console.log(`✅ CRUCE EXITOSO: Pago ${pagoCoincidente.id} aprobado por Bs. ${montoEncontrado}`);

            // Notificar al cliente por WhatsApp
            if (pagoCoincidente.remitenteJid && sockWhatsApp) {
                try {
                    await sockWhatsApp.sendMessage(pagoCoincidente.remitenteJid, {
                        text: `✅ ¡Pago aprobado!\n\nReferencia: ${referenciaEncontrada}\nMonto: Bs. ${montoEncontrado.toFixed(2)}\n\n¡Gracias por tu compra! 🎉`
                    });
                } catch (err) {
                    console.error("Error enviando notificación:", err);
                }
            }
        }

        res.json({ 
            status: "success", 
            referencia: referenciaEncontrada, 
            monto: montoEncontrado,
            cruzado: !!pagoCoincidente
        });
    } catch (error) {
        console.error("Error en webhook SMS:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// API para obtener pagos
app.get('/api/pagos', (req, res) => res.json(pagosBD));

// API para obtener SMS del banco
app.get('/api/sms', (req, res) => res.json(smsBancoBD));

// Ruta de simulación manual desde el index
app.post('/webhook/whatsapp', (req, res) => {
    const { cliente, telefono, referencia, monto, banco } = req.body;
    pagosBD.unshift({
        id: Date.now(),
        cliente: cliente || "Cliente Simulado",
        telefono: telefono || "+584120000000",
        ref: referencia || "9999",
        monto: parseFloat(monto) || 0.00,
        banco: banco || "Banco de Venezuela",
        estado: "pendiente",
        fecha: new Date().toLocaleTimeString()
    });
    res.json({ status: "success" });
});

// Ruta principal abre la interfaz visual
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});