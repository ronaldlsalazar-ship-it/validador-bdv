const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const { createWorker } = require('tesseract.js');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

let pagosBD = [];
let smsBancoBD = [];
let sockWhatsApp = null;
let ultimoQrGenerado = "";

// FUNCIONES DE EXTRACCIÓN (REGEX MEJORADA A 15 DÍGITOS)
function extraerReferencia(texto) {
    if (!texto) return "";
    const patrones = [
        /(?:operaci[oó]n|op|ref|referencia|nro|numero|num|transacci[oó]n|c[oó]digo)[^\d]*(\d{4,15})/i,
        /#(\d{4,15})/,
        /\b(\d{8,15})\b/
    ];
    for (const patron of patrones) {
        const match = texto.match(patron);
        if (match) return match[1];
    }
    return "";
}

function extraerMonto(texto) {
    if (!texto) return 0.00;
    const patrones = [
        /(?:monto|total|importe|bs|bs\.|bol[ií]vares)[^\d]*([\d.,]+)/i,
        /Bs\.?\s*([\d.,]+)/i,
        /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}?))/
    ];
    for (const patron of patrones) {
        const match = texto.match(patron);
        if (match) {
            let montoStr = match[1];
            if (montoStr.includes(',') && montoStr.includes('.')) {
                const ultimoComa = montoStr.lastIndexOf(',');
                const ultimoPunto = montoStr.lastIndexOf('.');
                montoStr = ultimoComa > ultimoPunto ? montoStr.replace(/\./g, '').replace(',', '.') : montoStr.replace(/,/g, '');
            } else if (montoStr.includes(',')) {
                const partes = montoStr.split(',');
                montoStr = partes[partes.length - 1].length <= 2 ? montoStr.replace(',', '.') : montoStr.replace(/,/g, '');
            }
            const monto = parseFloat(montoStr);
            if (!isNaN(monto) && monto > 0) return monto;
        }
    }
    return 0.00;
}

async function procesarImagenOCR(rutaImagen) {
    try {
        console.log("🔍 Iniciando OCR de la imagen...");
        const worker = await createWorker('spa+eng');
        const { data: { text } } = await worker.recognize(rutaImagen);
        await worker.terminate();
        console.log("📝 Texto extraído por OCR:", text.substring(0, 300));
        return text;
    } catch (error) {
        console.error("❌ Error en OCR:", error);
        return "";
    }
}

async function iniciarWhatsApp() {
    console.log("🔄 Iniciando conexión con WhatsApp...");
    // Railway usa /app como directorio raíz, esto funcionará perfectamente con el volumen
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
            console.log("\n📱 NUEVO QR GENERADO - Ve a /qr para verlo\n");
            qrcodeTerminal.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const razon = lastDisconnect?.error?.output?.statusCode;
            if (razon !== DisconnectReason.loggedOut) setTimeout(() => iniciarWhatsApp(), 5000);
        } else if (connection === 'open') {
            console.log('\n✅ WhatsApp vinculado y sesión guardada\n');
            ultimoQrGenerado = "";
        }
    });

    sockWhatsApp.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remitente = msg.key.remoteJid;
        const nombreCliente = msg.pushName || "Cliente";
        const telefonoLimpio = remitente.split('@')[0].replace(/[^0-9]/g, '');

        let contenido = msg.message;
        if (contenido.ephemeralMessage) contenido = contenido.ephemeralMessage.message;
        if (contenido.viewOnceMessage) contenido = contenido.viewOnceMessage.message;
        if (contenido.viewOnceMessageV2) contenido = contenido.viewOnceMessageV2.message;

        const esImagen = contenido.imageMessage;
        const textoPlano = contenido.conversation || contenido.extendedTextMessage?.text;

        console.log(`💬 De: ${nombreCliente} | Imagen: ${!!esImagen} | Texto: ${textoPlano || 'Ninguno'}`);

        if (textoPlano && !esImagen) {
            const ref = extraerReferencia(textoPlano);
            const monto = extraerMonto(textoPlano);
            pagosBD.unshift({
                id: Date.now(), cliente: nombreCliente, telefono: `+${telefonoLimpio}`,
                ref: ref || "SIN_REF", monto: monto, banco: "Por confirmar",
                estado: monto > 0 && ref ? "validado_parcial" : "pendiente",
                fecha: new Date().toLocaleString(), remitenteJid: remitente, textoOriginal: textoPlano
            });
            await sockWhatsApp.sendMessage(remitente, {
                text: `✅ Comprobante recibido.\n\n📋 Datos extraídos:\n• Ref: ${ref || 'No detectada'}\n• Monto: Bs. ${monto.toFixed(2)}\n\nPronto validaremos tu pago.`
            });
            return;
        }

        if (esImagen) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                    logger: undefined, reuploadRequest: sockWhatsApp.updateMediaMessage
                });
                const nombreArchivo = `comprobante_${Date.now()}.jpg`;
                const rutaCompleta = path.join(uploadDir, nombreArchivo);
                fs.writeFileSync(rutaCompleta, buffer);

                await sockWhatsApp.sendMessage(remitente, { text: `📸 Imagen recibida. Analizando con OCR... (espera 10-20 seg)` });

                const textoOCR = await procesarImagenOCR(rutaCompleta);
                const ref = extraerReferencia(textoOCR);
                const monto = extraerMonto(textoOCR);

                pagosBD.unshift({
                    id: Date.now(), cliente: nombreCliente, telefono: `+${telefonoLimpio}`,
                    ref: ref || "SIN_REF", monto: monto, banco: "Por confirmar",
                    estado: monto > 0 && ref ? "validado_parcial" : "pendiente",
                    fecha: new Date().toLocaleString(), remitenteJid: remitente,
                    imagen: nombreArchivo, textoOCR: textoOCR.substring(0, 500)
                });

                await sockWhatsApp.sendMessage(remitente, {
                    text: `✅ Imagen procesada.\n\n📋 Datos extraídos:\n• Ref: ${ref || 'No detectada'}\n• Monto: Bs. ${monto.toFixed(2)}\n\nPronto validaremos tu pago.`
                });
            } catch (error) {
                console.error("❌ Error procesando imagen:", error);
                await sockWhatsApp.sendMessage(remitente, { text: `❌ Error procesando la imagen. Envía los datos por texto.` });
            }
        }
    });
}

iniciarWhatsApp();

app.get('/qr', async (req, res) => {
    if (!ultimoQrGenerado) return res.send(`<div style="text-align:center; padding:40px; font-family:Arial;"><h2 style="color:green;">✅ WhatsApp vinculado</h2></div>`);
    try {
        const url = await qrcode.toDataURL(ultimoQrGenerado);
        res.send(`<div style="text-align:center; padding:20px;"><h2>📱 Escanea el QR</h2><img src="${url}" style="max-width:400px;"></div>`);
    } catch (err) { res.status(500).send("Error generando QR"); }
});

app.post('/webhook/sms-banco', async (req, res) => {
    try {
        const { texto } = req.body;
        console.log(`\n🔔 [SMS BDV]: ${texto}`);
        smsBancoBD.unshift({ id: Date.now(), texto: texto, fecha: new Date().toLocaleString() });

        const ref = extraerReferencia(texto);
        const monto = extraerMonto(texto);
        console.log(`📊 Extraído → Ref: ${ref} | Monto: ${monto}`);

        if (!ref || monto === 0) return res.json({ status: "info", message: "No se pudo extraer datos del SMS", refExtraida: ref, montoExtraido: monto });

        const pagoCoincidente = pagosBD.find(p => p.estado === "pendiente" && (p.ref === ref || p.ref === "PENDIENTE_" + ref || p.ref === "SIN_REF"));

        if (pagoCoincidente) {
            pagoCoincidente.estado = "aprobado";
            pagoCoincidente.monto = monto;
            pagoCoincidente.ref = ref;
            pagoCoincidente.fechaAprobacion = new Date().toLocaleString();
            console.log(`✅ CRUCE EXITOSO: Pago ${pagoCoincidente.id} aprobado`);

            if (pagoCoincidente.remitenteJid && sockWhatsApp) {
                try {
                    await sockWhatsApp.sendMessage(pagoCoincidente.remitenteJid, { text: `✅ ¡Pago aprobado!\n\nRef: ${ref}\nMonto: Bs. ${monto.toFixed(2)}\n\n¡Gracias! 🎉` });
                } catch (err) { console.error("Error notificando:", err); }
            }
        }
        res.json({ status: "success", referencia: ref, monto: monto, cruzado: !!pagoCoincidente });
    } catch (error) {
        console.error("Error webhook SMS:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get('/api/pagos', (req, res) => res.json(pagosBD));
app.get('/api/sms', (req, res) => res.json(smsBancoBD));

app.post('/webhook/whatsapp', (req, res) => {
    const { cliente, telefono, referencia, monto, banco } = req.body;
    pagosBD.unshift({ id: Date.now(), cliente: cliente || "Simulado", telefono: telefono || "+584120000000", ref: referencia || "9999", monto: parseFloat(monto) || 0.00, banco: banco || "Banco de Venezuela", estado: "pendiente", fecha: new Date().toLocaleString() });
    res.json({ status: "success" });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));