const { webcrypto } = require('crypto');
globalThis.crypto = webcrypto;
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ==========================================
// CONFIGURACIÓN PARA RAILWAY
// ==========================================
const authDir = process.env.AUTH_DIR || path.join(__dirname, 'sesion_whatsapp');
console.log(`\n🔐 Sesión WhatsApp guardada en: ${authDir}`);
console.log(`📂 Uploads en: ${uploadDir}\n`);

let pagosBD = [];
let smsBancoBD = [];
let sockWhatsApp = null;
let ultimoQrGenerado = "";
let isConnecting = false;
let estadoConexion = 'iniciando'; // iniciando | esperando_qr | conectado | error | reconectando
let ultimoError = '';
let intentosConexion = 0;
const MAX_INTENTOS = 5;

// ==========================================
// MAPA DE CÓDIGOS DE BANCO EN VENEZUELA
// ==========================================
const CODIGOS_BANCO = {
    '0102': 'Banco de Venezuela',
    '0104': 'Banco Venezolano de Crédito',
    '0105': 'Provincial',
    '0108': 'Mercantil',
    '0114': 'Banco Caroní',
    '0115': 'Banco Exterior',
    '0116': 'Banco Occidental de Descuento',
    '0128': 'Banco del Caribe',
    '0134': 'Banesco',
    '0137': 'Banco Sofitasa',
    '0138': 'Banco Plaza',
    '0146': 'Bangente',
    '0151': 'Banco Fondo Común',
    '0156': '100% Banco',
    '0157': 'Banco del Sur',
    '0163': 'Banco del Microempresario',
    '0166': 'Banco Activo',
    '0168': 'Bancrecer',
    '0169': 'Mi Banco',
    '0171': 'Banco Nacional de Crédito',
    '0172': 'Bancamiga',
    '0174': 'Banplus',
    '0175': 'Bancaribe',
    '0177': 'Banco de la Fuerza Armada',
    '0191': 'Banco del Tesoro'
};
const LISTA_BANCOS = Object.values(CODIGOS_BANCO);

// ==========================================
// DETECCIÓN DE BANCO POR CÓDIGO DE CUENTA
// ==========================================
function detectarBancoPorCodigoCuenta(texto) {
    if (!texto) return null;
    const cuentas = texto.match(/\b(0\d{3})\d{16}\b/g) || [];
    const cuentasCortas = texto.match(/\b(0\d{3})[\s-]?\d{4}[\s-]?\d{2}[\s-]?\d{8,10}\b/g) || [];
    const todas = [...cuentas, ...cuentasCortas];
    for (const cuenta of todas) {
        const codigo = cuenta.substring(0, 4);
        if (CODIGOS_BANCO[codigo]) {
            console.log(`🏦 Banco detectado por código ${codigo}: ${CODIGOS_BANCO[codigo]}`);
            return CODIGOS_BANCO[codigo];
        }
    }
    return null;
}

// ==========================================
// EXTRACCIÓN DE REFERENCIA
// ==========================================
function extraerReferencia(texto) {
    if (!texto) return "";
    const limpio = texto.replace(/\s+/g, ' ').replace(/[|]/g, 'I');
    const patrones = [
        /N[UÚ]MERO\s*DE\s*REFERENCIA[:\s]*(\d{8,15})/i,
        /NUMERO\s*DE\s*REFERENCIA[:\s]*(\d{8,15})/i,
        /Operaci[oó]n[:\s]*(\d{8,15})/i,
        /(\d{8,12})\s+Pago/i,
        /Ref\.?\s*del?\s*abono[^\d]{0,50}(\d{6,15})/i,
        /Ref\.?\s*de\s*abono[^\d]{0,50}(\d{6,15})/i,
        /REFERENCIA[^\d]{0,20}(\d{10,14})/i,
        /\b(06\d{10})\b/,
        /(?:ref\.?|referencia|nro\.?\s*ref|n[uú]mero\s*de\s*referencia)[^\d]{0,25}(\d{8,15})/i,
        /#\s*(\d{8,15})/i,
        /(?:nro\.?|n[uú]m\.?|n[uú]mero)\s*(?:de\s*)?(?:referencia|operaci[oó]n|control)[^\d]{0,15}(\d{8,15})/i
    ];
    for (const patron of patrones) {
        const match = limpio.match(patron);
        if (match && match[1]) {
            const ref = match[1].trim();
            if (ref.startsWith('V') || ref.startsWith('J') || ref.startsWith('E')) continue;
            if (ref.length === 11 && (ref.startsWith('0414') || ref.startsWith('0424') || ref.startsWith('0412') || ref.startsWith('0416') || ref.startsWith('0426'))) continue;
            if (ref.length >= 18 && (ref.startsWith('0102') || ref.startsWith('0134') || ref.startsWith('0105'))) continue;
            if (ref === '52477538' || ref === '12886291') continue;
            if (ref.length >= 8 && ref.length <= 14) {
                console.log(`✅ Referencia detectada: ${ref}`);
                return ref;
            }
        }
    }
    const numerosLargos = limpio.match(/\b(\d{10,14})\b/g) || [];
    for (const num of numerosLargos) {
        if (
            num.length >= 8 && num.length <= 14 &&
            !num.startsWith('0414') && !num.startsWith('0424') &&
            !num.startsWith('0412') && !num.startsWith('0416') &&
            !num.startsWith('0426') && !num.startsWith('0212')
        ) {
            console.log(`✅ Referencia (fallback): ${num}`);
            return num;
        }
    }
    return "";
}

// ==========================================
// NORMALIZACIÓN DE MONTOS (BUG CORREGIDO)
// ==========================================
function normalizarMontoVE(str) {
    if (!str) return 0;
    let limpio = String(str).replace(/\s/g, '');
    if (limpio.includes(',')) {
        // Formato VE: 1.234,56  ->  1234.56
        limpio = limpio.replace(/\./g, '').replace(',', '.');
    } else {
        const partes = limpio.split('.');
        if (partes.length > 2) {
            // Formato mixto: 1.234.56 -> 1234.56
            const dec = partes.pop();
            limpio = partes.join('') + '.' + dec;
        }
    }
    const num = parseFloat(limpio);
    return isNaN(num) ? 0 : num;
}

// ==========================================
// EXTRACCIÓN DE MONTO
// ==========================================
function extraerMonto(texto) {
    if (!texto) return 0.00;
    const limpio = texto.replace(/\s+/g, ' ');

    const matchPersonal = limpio.match(/\b(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:Bs|bs|BS)?\b/);
    if (matchPersonal) {
        const monto = normalizarMontoVE(matchPersonal[1]);
        if (monto > 0) return monto;
    }

    const matchBDV = limpio.match(/\b(\d{1,3}(?:\.\d{3})+\.\d{2})\b/);
    if (matchBDV) {
        const partes = matchBDV[1].split('.');
        const decimales = partes.pop();
        const entero = partes.join('');
        const monto = parseFloat(entero + '.' + decimales);
        if (!isNaN(monto) && monto > 0) return monto;
    }

    const patronesConEtiqueta = [
        /(?:monto|total|importe|valor|bs\.?|bol[ií]vares?|cantidad)[^\d]{0,15}([\d]{1,3}(?:[.\s]\d{3})*(?:[.,]\d{1,2})?)/i,
        /Bs\.?\s*([\d]{1,3}(?:[.\s]\d{3})*(?:[.,]\d{1,2})?)/i
    ];
    for (const patron of patronesConEtiqueta) {
        const match = limpio.match(patron);
        if (match) {
            const monto = normalizarMontoVE(match[1]);
            if (monto > 0 && monto < 999999999) return monto;
        }
    }

    const matchSimple = limpio.match(/\b(\d{1,7}[.,]\d{2})\b/);
    if (matchSimple) {
        const monto = normalizarMontoVE(matchSimple[1]);
        if (monto > 0) return monto;
    }
    return 0.00;
}

// ==========================================
// EXTRACCIÓN DE FECHA
// ==========================================
function extraerFecha(texto) {
    if (!texto) return "";
    let match = texto.match(/(\d{2}[/-.]\d{2}[/-.]\d{4})/);
    if (match) return match[1].replace(/[-.]/g, '/');
    match = texto.match(/(\d{2}):(\d{2}):(\d{4})/);
    if (match) return `${match[1]}/${match[2]}/${match[3]}`;
    match = texto.match(/(\d{2}[/-.]\d{2}[/-.]\d{2})\b/);
    if (match) {
        const partes = match[1].replace(/[-.]/g, '/').split('/');
        return `${partes[0]}/${partes[1]}/20${partes[2]}`;
    }
    return "";
}

// ==========================================
// EXTRACCIÓN DE BANCO EMISOR
// ==========================================
function extraerBanco(texto) {
    if (!texto) return "Por confirmar";
    const limpio = texto.toLowerCase();
    const bancoPorCodigo = detectarBancoPorCodigoCuenta(texto);
    if (bancoPorCodigo) return bancoPorCodigo;

    const patronesBanco = [
        /pago\s*m[oó]vil\s*(?:desde|de)?[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\s+(?:a|para|por)|\n|$)/i,
        /transferencia\s*(?:desde|de)?[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\s+(?:a|para|por)|\n|$)/i,
        /banco\s*(?:emisor|origen)[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\n|$)/i,
        /origen[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\n|$)/i
    ];
    for (const patron of patronesBanco) {
        const match = texto.match(patron);
        if (match && match[1]) {
            const candidato = match[1].trim();
            for (const [codigo, nombre] of Object.entries(CODIGOS_BANCO)) {
                if (candidato.toLowerCase().includes(nombre.toLowerCase())) {
                    return nombre;
                }
            }
        }
    }

    const bancos = [
        { nombre: "Bancamiga", claves: ["bancamiga"] },
        { nombre: "Banesco", claves: ["banesco", "banesco banco universal"] },
        { nombre: "Mercantil", claves: ["mercantil"] },
        { nombre: "Provincial", claves: ["provincial", "bbva"] },
        { nombre: "Banco de Venezuela", claves: ["banco de venezuela", "bdv"] },
        { nombre: "Bancaribe", claves: ["bancaribe"] },
        { nombre: "Banco del Tesoro", claves: ["tesoro"] },
        { nombre: "Banco Exterior", claves: ["exterior"] },
        { nombre: "Banco Caroní", claves: ["caroní", "caroni"] },
        { nombre: "Banco Plaza", claves: ["plaza"] },
        { nombre: "Banco Activo", claves: ["activo"] },
        { nombre: "Banco Sofitasa", claves: ["sofitasa"] },
        { nombre: "Banplus", claves: ["banplus"] },
        { nombre: "Mi Banco", claves: ["mi banco"] },
        { nombre: "Banco Nacional de Crédito", claves: ["nacional de crédito", "bnc"] }
    ];
    for (const banco of bancos) {
        for (const clave of banco.claves) {
            if (limpio.includes(clave)) return banco.nombre;
        }
    }
    return "Por confirmar";
}

// ==========================================
// PREPROCESAMIENTO DE IMAGEN
// ==========================================
async function preprocesarImagen(rutaOriginal) {
    const rutaNormal = path.join(uploadDir, `ocr_normal_${Date.now()}.png`);
    const rutaInvertida = path.join(uploadDir, `ocr_invertida_${Date.now()}.png`);
    try {
        await sharp(rutaOriginal)
            .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: false })
            .grayscale()
            .normalize()
            .sharpen({ sigma: 1.5 })
            .threshold(128)
            .png({ compressionLevel: 6 })
            .toFile(rutaNormal);

        await sharp(rutaOriginal)
            .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: false })
            .negate()
            .grayscale()
            .normalize()
            .sharpen({ sigma: 1.5 })
            .threshold(128)
            .png({ compressionLevel: 6 })
            .toFile(rutaInvertida);

        return { normal: rutaNormal, invertida: rutaInvertida };
    } catch (err) {
        console.error("⚠️ Error en preprocesamiento:", err.message);
        return { normal: rutaOriginal, invertida: null };
    }
}

// ==========================================
// OCR
// ==========================================
async function procesarImagenOCR(rutaImagen) {
    let rutas = null;
    try {
        console.log("🔍 Iniciando OCR...");
        rutas = await preprocesarImagen(rutaImagen);

        const worker = await createWorker('spa+eng', 1);
        await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÉÍÓÚáéíóúÑñ.,:/-#Bs$%() ',
            classify_bln_numeric_mode: '1',
            preserve_interword_spaces: '1'
        });

        const { data: { text: textoNormal } } = await worker.recognize(rutas.normal);
        let textoInvertido = "";
        if (rutas.invertida && fs.existsSync(rutas.invertida)) {
            const { data: { text } } = await worker.recognize(rutas.invertida);
            textoInvertido = text;
        }
        await worker.terminate();

        if (rutas.normal !== rutaImagen && fs.existsSync(rutas.normal)) {
            try { fs.unlinkSync(rutas.normal); } catch (e) {}
        }
        if (rutas.invertida && fs.existsSync(rutas.invertida)) {
            try { fs.unlinkSync(rutas.invertida); } catch (e) {}
        }
        return textoNormal + "\n" + textoInvertido;
    } catch (error) {
        console.error("❌ Error en OCR:", error);
        if (rutas) {
            if (rutas.normal && rutas.normal !== rutaImagen && fs.existsSync(rutas.normal)) {
                try { fs.unlinkSync(rutas.normal); } catch (e) {}
            }
            if (rutas.invertida && fs.existsSync(rutas.invertida)) {
                try { fs.unlinkSync(rutas.invertida); } catch (e) {}
            }
        }
        return "";
    }
}

// ==========================================
// WHATSAPP - CONEXIÓN MEJORADA
// ==========================================
async function iniciarWhatsApp(forceNew = false) {
    if (isConnecting && !forceNew) {
        console.log("⏳ Ya hay una conexión en proceso...");
        return;
    }
    isConnecting = true;
    estadoConexion = 'iniciando';
    ultimoError = '';
    console.log("🔄 Iniciando WhatsApp...");

    try {
        if (forceNew && fs.existsSync(authDir)) {
            console.log("🗑️  Limpiando sesión anterior...");
            fs.rmSync(authDir, { recursive: true, force: true });
        }
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }

        let version = [2, 3000, 1037641644];
        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;
            console.log(`✅ Usando versión Baileys: ${version.join('.')}`);
        } catch (e) {
            console.log(`⚠️  Usando versión fija: ${version.join('.')}`);
        }

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        sockWhatsApp = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            version: version
        });

        sockWhatsApp.ev.on('creds.update', saveCreds);

        sockWhatsApp.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                ultimoQrGenerado = qr;
                estadoConexion = 'esperando_qr';
                console.log("\n📱 NUEVO QR GENERADO → Ve a /qr para escanearlo\n");
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || 'Sin mensaje de error';
                console.log(`❌ Desconectado. Código: ${statusCode ?? 'undefined'}`);
                console.log(`   Motivo: ${errorMsg}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('🔒 Sesión cerrada (loggedOut). Usa /api/restart-whatsapp para reiniciar.');
                    estadoConexion = 'error';
                    ultimoError = 'Sesión cerrada desde el teléfono. Presiona "Forzar nuevo QR".';
                    ultimoQrGenerado = "";
                    return;
                }

                estadoConexion = 'reconectando';
                intentosConexion++;
                if (intentosConexion > MAX_INTENTOS) {
                    console.log('⚠️  Demasiados intentos fallidos.');
                    estadoConexion = 'error';
                    ultimoError = 'Demasiados intentos fallidos. Presiona "Forzar nuevo QR".';
                    return;
                }
                console.log(`🔄 Reintentando (${intentosConexion}/${MAX_INTENTOS}) en 5 segundos...`);
                setTimeout(() => iniciarWhatsApp(false), 5000);

            } else if (connection === 'open') {
                isConnecting = false;
                intentosConexion = 0;
                estadoConexion = 'conectado';
                ultimoError = '';
                console.log('\n✅ WhatsApp conectado correctamente\n');
                ultimoQrGenerado = "";
            }
        });

        // ==================== MENSAJES ====================
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
            console.log(`💬 De: ${nombreCliente} | Imagen: ${!!esImagen}`);

            if (textoPlano && !esImagen) {
                const ref = extraerReferencia(textoPlano);
                const monto = extraerMonto(textoPlano);
                const fechaComprobante = extraerFecha(textoPlano);
                const bancoDetectado = extraerBanco(textoPlano);

                if (!ref && monto === 0) {
                    await sockWhatsApp.sendMessage(remitente, {
                        text: `Hola ${nombreCliente} 👋\n\nEnvía una imagen del comprobante o escribe:\n_"Ref: 12345678 Monto: Bs. 150,00"_`
                    });
                    return;
                }

                pagosBD.unshift({
                    id: Date.now(),
                    cliente: nombreCliente,
                    telefono: `+${telefonoLimpio}`,
                    ref: ref || "SIN_REF",
                    monto: monto,
                    banco: bancoDetectado,
                    estado: "pendiente",
                    fecha: fechaComprobante || new Date().toLocaleString(),
                    remitenteJid: remitente,
                    imagen: null,
                    textoOCR: textoPlano.substring(0, 600)
                });

                await sockWhatsApp.sendMessage(remitente, {
                    text: `✅ Comprobante recibido.\n\n📋 Datos:\n• Ref: ${ref || 'No detectada'}\n• Monto: Bs. ${monto.toFixed(2)}\n• Banco: ${bancoDetectado}\n\nPronto validaremos.`
                });
                return;
            }

            if (esImagen) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: undefined,
                        reuploadRequest: sockWhatsApp.updateMediaMessage
                    });
                    const nombreArchivo = `comprobante_${Date.now()}.jpg`;
                    const rutaCompleta = path.join(uploadDir, nombreArchivo);
                    fs.writeFileSync(rutaCompleta, buffer);

                    await sockWhatsApp.sendMessage(remitente, {
                        text: `📸 Imagen recibida. Analizando...`
                    });

                    const textoOCR = await procesarImagenOCR(rutaCompleta);
                    const ref = extraerReferencia(textoOCR);
                    const monto = extraerMonto(textoOCR);
                    const fechaComprobante = extraerFecha(textoOCR);
                    const bancoDetectado = extraerBanco(textoOCR);
                    console.log(`🏦 Banco: ${bancoDetectado}`);

                    pagosBD.unshift({
                        id: Date.now(),
                        cliente: nombreCliente,
                        telefono: `+${telefonoLimpio}`,
                        ref: ref || "SIN_REF",
                        monto: monto,
                        banco: bancoDetectado,
                        estado: "pendiente",
                        fecha: fechaComprobante || new Date().toLocaleString(),
                        remitenteJid: remitente,
                        imagen: nombreArchivo,
                        textoOCR: textoOCR.substring(0, 600)
                    });

                    await sockWhatsApp.sendMessage(remitente, {
                        text: `✅ Imagen procesada.\n\n📋 Datos:\n• Ref: ${ref || 'No detectada'}\n• Monto: Bs. ${monto.toFixed(2)}\n• Banco: ${bancoDetectado}\n\nPronto validaremos.`
                    });
                } catch (error) {
                    console.error("Error procesando imagen:", error);
                    await sockWhatsApp.sendMessage(remitente, {
                        text: `❌ Error procesando la imagen. Envía los datos por texto.`
                    });
                }
            }
        });

    } catch (err) {
        isConnecting = false;
        estadoConexion = 'error';
        ultimoError = err.message;
        console.error("❌ Error al iniciar WhatsApp:", err.message);
        setTimeout(() => iniciarWhatsApp(false), 8000);
    }
}

// Iniciar WhatsApp
iniciarWhatsApp();

// ==========================================
// ENDPOINTS
// ==========================================
app.get('/api/bancos', (req, res) => {
    res.json(LISTA_BANCOS);
});

// Estado del QR (polling desde qr.html)
app.get('/api/qr-status', async (req, res) => {
    try {
        if (!ultimoQrGenerado) {
            return res.json({
                status: estadoConexion,
                qr: null,
                message: estadoConexion === 'conectado'
                    ? '✅ WhatsApp ya está vinculado'
                    : estadoConexion === 'error'
                        ? `❌ ${ultimoError}`
                        : '⏳ Esperando QR...'
            });
        }
        const url = await qrcode.toDataURL(ultimoQrGenerado, { width: 400, margin: 2 });
        res.json({ status: 'esperando_qr', qr: url, message: '📱 Escanea el QR' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Reiniciar WhatsApp manualmente
app.post('/api/restart-whatsapp', (req, res) => {
    console.log("🔄 Reinicio manual solicitado...");
    estadoConexion = 'reconectando';
    ultimoQrGenerado = "";
    intentosConexion = 0;
    isConnecting = false;
    iniciarWhatsApp(true);
    res.json({ status: 'success', message: 'Reiniciando WhatsApp...' });
});

// Diagnóstico
app.get('/api/status', (req, res) => {
    res.json({
        estado: estadoConexion,
        socketActivo: sockWhatsApp !== null,
        qrDisponible: !!ultimoQrGenerado,
        intentos: intentosConexion,
        ultimoError: ultimoError,
        sesionDir: authDir,
        sesionExiste: fs.existsSync(authDir),
        archivosSesion: fs.existsSync(authDir) ? fs.readdirSync(authDir).length : 0,
        uptimeSegundos: Math.round(process.uptime()),
        pagos: pagosBD.length,
        sms: smsBancoBD.length
    });
});

app.patch('/api/pagos/:id/banco', (req, res) => {
    const id = parseInt(req.params.id);
    const { banco } = req.body;
    if (!banco || typeof banco !== 'string') {
        return res.status(400).json({ status: "error", message: "Banco inválido" });
    }
    const pago = pagosBD.find(p => p.id === id);
    if (!pago) {
        return res.status(404).json({ status: "error", message: "Pago no encontrado" });
    }
    pago.banco = banco;
    pago.bancoManual = true;
    pago.fechaEdicion = new Date().toLocaleString();
    res.json({ status: "success", id, banco });
});

app.patch('/api/pagos/:id/estado', (req, res) => {
    const id = parseInt(req.params.id);
    const { estado } = req.body;
    const pago = pagosBD.find(p => p.id === id);
    if (!pago) return res.status(404).json({ status: "error", message: "Pago no encontrado" });
    pago.estado = estado;
    pago.fechaAprobacion = new Date().toLocaleString();
    res.json({ status: "success", id, estado });
});

// Página del QR
app.get('/qr', (req, res) => {
    const rutaQr = path.join(__dirname, 'qr.html');
    if (fs.existsSync(rutaQr)) return res.sendFile(rutaQr);
    res.status(500).send('<h2>Falta el archivo qr.html en el proyecto</h2>');
});

app.post('/webhook/sms-banco', async (req, res) => {
    try {
        const { texto } = req.body;
        smsBancoBD.unshift({ id: Date.now(), texto, fecha: new Date().toLocaleString() });

        const ref = extraerReferencia(texto);
        const monto = extraerMonto(texto);
        if (!ref || monto === 0) {
            return res.json({ status: "info", refExtraida: ref, montoExtraido: monto });
        }

        const pagoCoincidente = pagosBD.find(p =>
            p.estado === "pendiente" &&
            (p.ref === ref || p.ref === "PENDIENTE_" + ref || p.ref === "SIN_REF")
        );
        if (pagoCoincidente) {
            pagoCoincidente.estado = "aprobado";
            pagoCoincidente.monto = monto;
            pagoCoincidente.ref = ref;
            pagoCoincidente.fechaAprobacion = new Date().toLocaleString();
        }
        res.json({ status: "success", referencia: ref, monto, cruzado: !!pagoCoincidente });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get('/api/pagos', (req, res) => res.json(pagosBD));
app.get('/api/sms', (req, res) => res.json(smsBancoBD));

// ⚠️ AQUÍ ESTABA EL ERROR "= >" QUE ROMPÍA TODO
app.post('/webhook/whatsapp', (req, res) => {
    const { cliente, telefono, referencia, monto, banco, fecha } = req.body;
    pagosBD.unshift({
        id: Date.now(),
        cliente: cliente || "Simulado",
        telefono: telefono || "+584120000000",
        ref: referencia || "9999",
        monto: parseFloat(monto) || 0.00,
        banco: extraerBanco(banco || "") || banco || "Por confirmar",
        estado: "pendiente",
        fecha: fecha || new Date().toLocaleDateString()
    });
    res.json({ status: "success" });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📂 Sesión: ${authDir}`);
    console.log(`🌐 URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}\n`);
});