// server.js - Versión Definitiva con QR Optimizado para Render y Consola
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
        printQRInTerminal: false
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
            
            // Imprime un QR compacto en la consola de Render por si acaso
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
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remitente = msg.key.remoteJid;
        let nombreCliente = msg.pushName || "Cliente WhatsApp";
        const telefonoLimpio = remitente.split('@')[0].replace(/[^0-9]/g, '');

        let mensajeContenido = msg.message;
        if (mensajeContenido.ephemeralMessage) mensajeContenido = mensajeContenido.ephemeralMessage.message;
        if (mensajeContenido.viewOnceMessage) mensajeContenido = mensajeContenido.viewOnceMessage.message;
        // CORREGIDO: Se cambia 'mensajeContenedor' por 'mensajeContenido' para evitar errores
        if (mensajeContenido.viewOnceMessageV2) mensajeContenido = mensajeContenido.viewOnceMessageV2.message;

        const esImagen = mensajeContenido.imageMessage;

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
            } catch (error) {
                console.error("❌ Error al descargar imagen:", error);
            }
        }
    });
}

iniciarWhatsApp();

// Ruta web para ver el Código QR en imagen nítida
app.get('/qr', async (req, res) => {
    if (!ultimoQrGenerado) {
        return res.send(`<html><body style="background:#0f172a; color:white; font-family:sans-serif; text-align:center; padding-top:60px;">
            <h2>✅ ¡WhatsApp ya está vinculado correctamente!</h2>
            <p>Puedes cerrar esta ventana y usar tu panel principal.</p>
        </body></html>`);
    }
    try {
        const urlImagenQr = await qrcode.toDataURL(ultimoQrGenerado);
        res.send(`
            <html>
                <body style="background:#0f172a; color:white; font-family:sans-serif; text-align:center; padding-top:40px;">
                    <h2>Escanea este Código QR con tu Teléfono</h2>
                    <p>Abre WhatsApp en tu teléfono -> <b>Dispositivos Vinculados</b> -> <b>Vincular un dispositivo</b></p>
                    <div style="background:white; display:inline-block; padding:20px; border-radius:15px; margin-top:20px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
                        <img src="${urlImagenQr}" style="width:300px; height:300px;" />
                    </div>
                    <p style="margin-top:20px; color:#94a3b8; font-size:12px;">Si el código expira, recarga esta página en 10 segundos.</p>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send("Error generando la imagen QR.");
    }
});

app.post('/webhook/sms-banco', async (req, res) => {
    try {
        const { texto } = req.body;
        console.log(`\n🔔 [Notificación BDV]: ${texto}`);

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

        if (!referenciaEncontrada || referenciaEncontrada === "0000" || montoEncontrado <= 0) {
            return res.status(400).json({ status: "error", message: "Datos incompletos" });
        }

        smsBancoBD.unshift({
            id: Date.now(),
            texto: texto,
            ref: referenciaEncontrada,
            monto: montoEncontrado,
            hora: new Date().toLocaleTimeString()
        });

        for (let p of pagosBD) {
            if (p.estado === 'pendiente') {
                p.estado = 'aprobado';
                p.ref = referenciaEncontrada;
                p.monto = montoEncontrado;

                if (sockWhatsApp && p.remitenteJid) {
                    await sockWhatsApp.sendMessage(p.remitenteJid, {
                        text: `✅ ¡Pago Confirmado! Bs. ${montoEncontrado.toFixed(2)} (Ref: #${referenciaEncontrada}). ¡Gracias!`
                    });
                }
                break;
            }
        }

        res.status(200).json({ status: "success", ref: referenciaEncontrada, monto: montoEncontrado });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get('/api/pagos', (req, res) => res.json(pagosBD));
app.get('/api/sms', (req, res) => res.json(smsBancoBD));
app.get('/', (req, res) => res.send("Bot BDV Activo en Render"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});