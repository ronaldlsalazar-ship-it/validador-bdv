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
// CONFIGURACION PARA RAILWAY
// ==========================================
const authDir = process.env.AUTH_DIR || path.join(__dirname, 'sesion_whatsapp');
console.log('Sesion WhatsApp guardada en: ' + authDir);
console.log('Uploads en: ' + uploadDir);

let pagosBD = [];
let smsBancoBD = [];
let sockWhatsApp = null;
let ultimoQrGenerado = '';
let isConnecting = false;
let estadoConexion = 'iniciando';
let ultimoError = '';
let intentosConexion = 0;
const MAX_INTENTOS = 5;
const OCR_TIMEOUT_MS = 90000;

// ==========================================
// MAPA DE CODIGOS DE BANCO EN VENEZUELA
// ==========================================
const CODIGOS_BANCO = {
  '0102': 'Banco de Venezuela',
  '0104': 'Banco Venezolano de Credito',
  '0105': 'Provincial',
  '0108': 'Mercantil',
  '0114': 'Banco Caroni',
  '0115': 'Banco Exterior',
  '0116': 'Banco Occidental de Descuento',
  '0128': 'Banco del Caribe',
  '0134': 'Banesco',
  '0137': 'Banco Sofitasa',
  '0138': 'Banco Plaza',
  '0146': 'Bangente',
  '0151': 'Banco Fondo Comun',
  '0156': '100% Banco',
  '0157': 'Banco del Sur',
  '0163': 'Banco del Microempresario',
  '0166': 'Banco Activo',
  '0168': 'Bancrecer',
  '0169': 'Mi Banco',
  '0171': 'Banco Nacional de Credito',
  '0172': 'Bancamiga',
  '0174': 'Banplus',
  '0175': 'Bancaribe',
  '0177': 'Banco de la Fuerza Armada',
  '0191': 'Banco del Tesoro'
};
const LISTA_BANCOS = Object.values(CODIGOS_BANCO);

// ==========================================
// UTILIDAD: LIMITAR TIEMPO DE UNA PROMESA
// ==========================================
function conTimeout(promesa, ms, etiqueta) {
  let temporizador;
  const limite = new Promise(function(resolve, reject) {
    temporizador = setTimeout(function() {
      reject(new Error('Tiempo de espera agotado en ' + etiqueta));
    }, ms);
  });
  return Promise.race([promesa, limite]).finally(function() {
    clearTimeout(temporizador);
  });
}

// ==========================================
// DETECCION DE BANCO POR CODIGO DE CUENTA
// ==========================================
function detectarBancoPorCodigoCuenta(texto) {
  if (!texto) return null;
  const cuentas = texto.match(/\b(0\d{3})\d{16}\b/g) || [];
  const cuentasCortas = texto.match(/\b(0\d{3})[\s\-]?\d{4}[\s\-]?\d{2}[\s\-]?\d{8,10}\b/g) || [];
  const todas = [...cuentas, ...cuentasCortas];
  for (const cuenta of todas) {
    const codigo = cuenta.substring(0, 4);
    if (CODIGOS_BANCO[codigo]) {
      console.log('Banco detectado por codigo ' + codigo + ': ' + CODIGOS_BANCO[codigo]);
      return CODIGOS_BANCO[codigo];
    }
  }
  return null;
}

// ==========================================
// EXTRACCION DE REFERENCIA
// ==========================================
function extraerReferencia(texto) {
  if (!texto) return '';
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
        console.log('Referencia detectada: ' + ref);
        return ref;
      }
    }
  }
  const numerosLargos = limpio.match(/\b(\d{10,14})\b/g) || [];
  for (const num of numerosLargos) {
    if (num.length >= 8 && num.length <= 14 &&
        !num.startsWith('0414') && !num.startsWith('0424') &&
        !num.startsWith('0412') && !num.startsWith('0416') &&
        !num.startsWith('0426') && !num.startsWith('0212')) {
      console.log('Referencia (fallback): ' + num);
      return num;
    }
  }
  return '';
}

// ==========================================
// NORMALIZACION DE MONTOS
// ==========================================
function normalizarMontoVE(str) {
  if (!str) return 0;
  let limpio = str.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : num;
}

// ==========================================
// EXTRACCION DE MONTO
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
// EXTRACCION DE FECHA
// ==========================================
function extraerFecha(texto) {
  if (!texto) return '';
  let match = texto.match(/(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})/);
  if (match) return match[1].replace(/[\-\.]/g, '/');
  match = texto.match(/(\d{2}):(\d{2}):(\d{4})/);
  if (match) return match[1] + '/' + match[2] + '/' + match[3];
  match = texto.match(/(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{2})\b/);
  if (match) {
    const partes = match[1].replace(/[\-\.]/g, '/').split('/');
    return partes[0] + '/' + partes[1] + '/20' + partes[2];
  }
  return '';
}

// ==========================================
// EXTRACCION DE BANCO EMISOR
// ==========================================
function extraerBanco(texto) {
  if (!texto) return 'Por confirmar';
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
      for (const nombre of Object.values(CODIGOS_BANCO)) {
        if (candidato.toLowerCase().includes(nombre.toLowerCase())) return nombre;
      }
    }
  }
  const bancos = [
    { nombre: 'Bancamiga', claves: ['bancamiga'] },
    { nombre: 'Banesco', claves: ['banesco', 'banesco banco universal'] },
    { nombre: 'Mercantil', claves: ['mercantil'] },
    { nombre: 'Provincial', claves: ['provincial', 'bbva'] },
    { nombre: 'Banco de Venezuela', claves: ['banco de venezuela', 'bdv'] },
    { nombre: 'Bancaribe', claves: ['bancaribe'] },
    { nombre: 'Banco del Tesoro', claves: ['tesoro'] },
    { nombre: 'Banco Exterior', claves: ['exterior'] },
    { nombre: 'Banco Caroni', claves: ['caroni', 'caroní'] },
    { nombre: 'Banco Plaza', claves: ['plaza'] },
    { nombre: 'Banco Activo', claves: ['activo'] },
    { nombre: 'Banco Sofitasa', claves: ['sofitasa'] },
    { nombre: 'Banplus', claves: ['banplus'] },
    { nombre: 'Mi Banco', claves: ['mi banco'] },
    { nombre: 'Banco Nacional de Credito', claves: ['nacional de credito', 'nacional de crédito', 'bnc'] }
  ];
  for (const banco of bancos) {
    for (const clave of banco.claves) {
      if (limpio.includes(clave)) return banco.nombre;
    }
  }
  return 'Por confirmar';
}

// ==========================================
// PREPROCESAMIENTO DE IMAGEN
// ==========================================
async function preprocesarImagen(rutaOriginal) {
  const marca = Date.now();
  const rutaNormal = path.join(uploadDir, 'ocr_normal_' + marca + '.png');
  const rutaInvertida = path.join(uploadDir, 'ocr_invertida_' + marca + '.png');
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
    console.error('Error en preprocesamiento: ' + err.message);
    return { normal: rutaOriginal, invertida: null };
  }
}

// ==========================================
// OCR
// ==========================================
async function procesarImagenOCR(rutaImagen) {
  let rutas = null;
  let worker = null;
  try {
    console.log('[OCR] Iniciando proceso...');
    rutas = await conTimeout(preprocesarImagen(rutaImagen), 30000, 'preprocesamiento');
    worker = await conTimeout(createWorker('spa+eng', 1), 60000, 'carga de Tesseract');
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });
    const resultadoNormal = await conTimeout(worker.recognize(rutas.normal), 60000, 'lectura normal');
    const textoNormal = resultadoNormal.data.text || '';
    let textoInvertido = '';
    if (rutas.invertida && fs.existsSync(rutas.invertida)) {
      try {
        const resultadoInvertido = await conTimeout(worker.recognize(rutas.invertida), 60000, 'lectura invertida');
        textoInvertido = resultadoInvertido.data.text || '';
      } catch (e) {
        console.error('[OCR] Fallo lectura invertida: ' + e.message);
      }
    }
    console.log('[OCR] Proceso completado. Caracteres leidos: ' + (textoNormal.length + textoInvertido.length));
    return textoNormal + '\n' + textoInvertido;
  } catch (error) {
    console.error('[OCR] ERROR: ' + error.message);
    return '';
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (e) {}
    }
    if (rutas) {
      if (rutas.normal && rutas.normal !== rutaImagen && fs.existsSync(rutas.normal)) {
        try { fs.unlinkSync(rutas.normal); } catch (e) {}
      }
      if (rutas.invertida && fs.existsSync(rutas.invertida)) {
        try { fs.unlinkSync(rutas.invertida); } catch (e) {}
      }
    }
  }
}

// ==========================================
// WHATSAPP - CONEXION
// ==========================================
async function iniciarWhatsApp(forceNew) {
  if (isConnecting && !forceNew) {
    console.log('Ya hay una conexion en proceso...');
    return;
  }
  isConnecting = true;
  estadoConexion = 'iniciando';
  ultimoError = '';
  console.log('Iniciando WhatsApp...');

  try {
    if (forceNew && fs.existsSync(authDir)) {
      console.log('Limpiando sesion anterior...');
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    let version = [2, 3000, 1037641644];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      console.log('Usando version Baileys: ' + version.join('.'));
    } catch (e) {
      console.log('Usando version fija: ' + version.join('.'));
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

    sockWhatsApp.ev.on('connection.update', async function(update) {
      const connection = update.connection;
      const lastDisconnect = update.lastDisconnect;
      const qr = update.qr;

      if (qr) {
        ultimoQrGenerado = qr;
        estadoConexion = 'esperando_qr';
        console.log('NUEVO QR GENERADO - Ve a /qr para escanearlo');
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'close') {
        isConnecting = false;
        let statusCode = null;
        let errorMsg = 'Sin mensaje de error';
        if (lastDisconnect && lastDisconnect.error) {
          errorMsg = lastDisconnect.error.message || errorMsg;
          if (lastDisconnect.error.output) {
            statusCode = lastDisconnect.error.output.statusCode;
          }
        }
        console.log('Desconectado. Codigo: ' + (statusCode || 'undefined'));
        console.log('Motivo: ' + errorMsg);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Sesion cerrada (loggedOut).');
          estadoConexion = 'error';
          ultimoError = 'Sesion cerrada desde el telefono. Usa /api/restart-whatsapp';
          ultimoQrGenerado = '';
          return;
        }

        intentosConexion++;
        if (intentosConexion > MAX_INTENTOS) {
          console.log('Demasiados intentos fallidos.');
          estadoConexion = 'error';
          ultimoError = 'Demasiados intentos fallidos. Usa /api/restart-whatsapp';
          return;
        }
        estadoConexion = 'reconectando';
        console.log('Reintentando (' + intentosConexion + '/' + MAX_INTENTOS + ') en 5 segundos...');
        setTimeout(function() { iniciarWhatsApp(false); }, 5000);

      } else if (connection === 'open') {
        isConnecting = false;
        intentosConexion = 0;
        estadoConexion = 'conectado';
        console.log('WhatsApp conectado correctamente');
        ultimoQrGenerado = '';
      }
    });

    // ==================== MENSAJES ====================
    sockWhatsApp.ev.on('messages.upsert', async function(m) {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const remitente = msg.key.remoteJid;
      if (!remitente || remitente.indexOf('@g.us') !== -1) return;

      const nombreCliente = msg.pushName || 'Cliente';
      const telefonoLimpio = remitente.split('@')[0].replace(/[^0-9]/g, '');

      let contenido = msg.message;
      if (contenido.ephemeralMessage) contenido = contenido.ephemeralMessage.message;
      if (contenido.viewOnceMessage) contenido = contenido.viewOnceMessage.message;
      if (contenido.viewOnceMessageV2) contenido = contenido.viewOnceMessageV2.message;

      const esImagen = contenido.imageMessage;
      const textoPlano = contenido.conversation || (contenido.extendedTextMessage ? contenido.extendedTextMessage.text : null);
      console.log('De: ' + nombreCliente + ' | Imagen: ' + (!!esImagen));

      // ---------- MENSAJE DE TEXTO ----------
      if (textoPlano && !esImagen) {
        const ref = extraerReferencia(textoPlano);
        const monto = extraerMonto(textoPlano);
        const fechaComprobante = extraerFecha(textoPlano);
        const bancoDetectado = extraerBanco(textoPlano);

        if (!ref && monto === 0) {
          await sockWhatsApp.sendMessage(remitente, {
            text: 'Hola ' + nombreCliente + '\n\nEnvia una imagen del comprobante o escribe:\nRef: 12345678 Monto: Bs. 150,00'
          });
          return;
        }

        pagosBD.unshift({
          id: Date.now(),
          cliente: nombreCliente,
          telefono: '+' + telefonoLimpio,
          ref: ref || 'SIN_REF',
          monto: monto,
          banco: bancoDetectado,
          estado: 'pendiente',
          fecha: fechaComprobante || new Date().toLocaleString(),
          remitenteJid: remitente,
          imagen: null,
          textoOCR: textoPlano.substring(0, 600)
        });

        await sockWhatsApp.sendMessage(remitente, {
          text: 'Comprobante recibido.\n\nDatos:\n- Ref: ' + (ref || 'No detectada') + '\n- Monto: Bs. ' + monto.toFixed(2) + '\n- Banco: ' + bancoDetectado + '\n\nPronto validaremos.'
        });
        return;
      }

      // ---------- MENSAJE DE IMAGEN ----------
      if (esImagen) {
        let nombreArchivo = null;
        let rutaCompleta = null;
        try {
          console.log('[WHATSAPP] Descargando imagen...');
          const buffer = await conTimeout(
            downloadMediaMessage(msg, 'buffer', {}, {
              logger: undefined,
              reuploadRequest: sockWhatsApp.updateMediaMessage
            }),
            60000,
            'descarga de imagen'
          );
          nombreArchivo = 'comprobante_' + Date.now() + '.jpg';
          rutaCompleta = path.join(uploadDir, nombreArchivo);
          fs.writeFileSync(rutaCompleta, buffer);
          console.log('[WHATSAPP] Imagen guardada: ' + nombreArchivo);
          await sockWhatsApp.sendMessage(remitente, { text: 'Imagen recibida. Analizando...' });
        } catch (error) {
          console.error('[WHATSAPP] Error descargando imagen: ' + error.message);
          try {
            await sockWhatsApp.sendMessage(remitente, { text: 'No pudimos descargar la imagen. Envia los datos por texto.' });
          } catch (e) {}
          return;
        }

        let textoOCR = '';
        try {
          textoOCR = await conTimeout(procesarImagenOCR(rutaCompleta), OCR_TIMEOUT_MS, 'OCR');
        } catch (error) {
          console.error('[WHATSAPP] OCR detenido: ' + error.message);
          textoOCR = '';
        }

        const ref = extraerReferencia(textoOCR);
        const monto = extraerMonto(textoOCR);
        const fechaComprobante = extraerFecha(textoOCR);
        const bancoDetectado = extraerBanco(textoOCR);

        console.log('[WHATSAPP] Banco: ' + bancoDetectado + ' | Ref: ' + (ref || 'SIN_REF') + ' | Monto: ' + monto);

        // SIEMPRE se registra el pago, aunque el OCR falle
        pagosBD.unshift({
          id: Date.now(),
          cliente: nombreCliente,
          telefono: '+' + telefonoLimpio,
          ref: ref || 'SIN_REF',
          monto: monto,
          banco: bancoDetectado,
          estado: 'pendiente',
          fecha: fechaComprobante || new Date().toLocaleString(),
          remitenteJid: remitente,
          imagen: nombreArchivo,
          ocrFallido: !textoOCR,
          textoOCR: (textoOCR || 'OCR sin resultado').substring(0, 600)
        });

        try {
          if (!textoOCR) {
            await sockWhatsApp.sendMessage(remitente, {
              text: 'Recibimos tu comprobante pero no pudimos leerlo automaticamente.\nYa lo registramos para revision manual.\n\nSi quieres, escribe:\nRef: 12345678 Monto: Bs. 150,00'
            });
          } else {
            await sockWhatsApp.sendMessage(remitente, {
              text: 'Imagen procesada.\n\nDatos:\n- Ref: ' + (ref || 'No detectada') + '\n- Monto: Bs. ' + monto.toFixed(2) + '\n- Banco: ' + bancoDetectado + '\n\nPronto validaremos.'
            });
          }
        } catch (e) {
          console.error('[WHATSAPP] Error enviando confirmacion: ' + e.message);
        }
      }
    });

  } catch (err) {
    isConnecting = false;
    estadoConexion = 'error';
    ultimoError = err.message;
    console.error('Error al iniciar WhatsApp: ' + err.message);
    setTimeout(function() { iniciarWhatsApp(false); }, 8000);
  }
}

iniciarWhatsApp();

// ==========================================
// ENDPOINTS
// ==========================================
app.get('/api/bancos', function(req, res) {
  res.json(LISTA_BANCOS);
});

app.get('/api/qr-status', async function(req, res) {
  try {
    if (!ultimoQrGenerado) {
      let mensaje = 'Esperando QR...';
      if (estadoConexion === 'conectado') mensaje = 'WhatsApp ya esta vinculado';
      if (estadoConexion === 'error') mensaje = 'Error: ' + ultimoError;
      return res.json({ status: estadoConexion, qr: null, message: mensaje });
    }
    const url = await qrcode.toDataURL(ultimoQrGenerado);
    res.json({ status: 'esperando_qr', qr: url, message: 'Escanea el QR' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/restart-whatsapp', function(req, res) {
  console.log('Reinicio manual solicitado...');
  estadoConexion = 'reconectando';
  ultimoQrGenerado = '';
  intentosConexion = 0;
  isConnecting = false;
  iniciarWhatsApp(true);
  res.json({ status: 'success', message: 'Reiniciando WhatsApp...' });
});

app.get('/api/status', function(req, res) {
  res.json({
    estado: estadoConexion,
    conectado: sockWhatsApp !== null,
    qrDisponible: !!ultimoQrGenerado,
    intentos: intentosConexion,
    ultimoError: ultimoError,
    sesionDir: authDir,
    sesionExiste: fs.existsSync(authDir),
    archivosSesion: fs.existsSync(authDir) ? fs.readdirSync(authDir).length : 0,
    uptime: process.uptime(),
    pagos: pagosBD.length,
    sms: smsBancoBD.length
  });
});

app.patch('/api/pagos/:id/banco', function(req, res) {
  const id = parseInt(req.params.id);
  const banco = req.body.banco;
  if (!banco || typeof banco !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Banco invalido' });
  }
  const pago = pagosBD.find(function(p) { return p.id === id; });
  if (!pago) {
    return res.status(404).json({ status: 'error', message: 'Pago no encontrado' });
  }
  pago.banco = banco;
  pago.bancoManual = true;
  pago.fechaEdicion = new Date().toLocaleString();
  res.json({ status: 'success', id: id, banco: banco });
});

app.patch('/api/pagos/:id/estado', function(req, res) {
  const id = parseInt(req.params.id);
  const estado = req.body.estado;
  const pago = pagosBD.find(function(p) { return p.id === id; });
  if (!pago) {
    return res.status(404).json({ status: 'error', message: 'Pago no encontrado' });
  }
  pago.estado = estado;
  pago.fechaAprobacion = new Date().toLocaleString();
  res.json({ status: 'success', id: id, estado: estado });
});

app.get('/qr', function(req, res) {
  res.sendFile(path.join(__dirname, 'qr.html'));
});

app.post('/webhook/sms-banco', function(req, res) {
  try {
    const texto = req.body.texto;
    smsBancoBD.unshift({ id: Date.now(), texto: texto, fecha: new Date().toLocaleString() });
    const ref = extraerReferencia(texto);
    const monto = extraerMonto(texto);
    if (!ref || monto === 0) {
      return res.json({ status: 'info', refExtraida: ref, montoExtraido: monto });
    }
    const pagoCoincidente = pagosBD.find(function(p) {
      return p.estado === 'pendiente' && (p.ref === ref || p.ref === 'PENDIENTE_' + ref || p.ref === 'SIN_REF');
    });
    if (pagoCoincidente) {
      pagoCoincidente.estado = 'aprobado';
      pagoCoincidente.monto = monto;
      pagoCoincidente.ref = ref;
      pagoCoincidente.fechaAprobacion = new Date().toLocaleString();
    }
    res.json({ status: 'success', referencia: ref, monto: monto, cruzado: !!pagoCoincidente });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/pagos', function(req, res) {
  res.json(pagosBD);
});

app.get('/api/sms', function(req, res) {
  res.json(smsBancoBD);
});

app.post('/webhook/whatsapp', function(req, res) {
  const cliente = req.body.cliente;
  const telefono = req.body.telefono;
  const referencia = req.body.referencia;
  const monto = req.body.monto;
  const banco = req.body.banco;
  const fecha = req.body.fecha;
  pagosBD.unshift({
    id: Date.now(),
    cliente: cliente || 'Simulado',
    telefono: telefono || '+584120000000',
    ref: referencia || '9999',
    monto: parseFloat(monto) || 0.00,
    banco: extraerBanco(banco || '') || banco || 'Por confirmar',
    estado: 'pendiente',
    fecha: fecha || new Date().toLocaleDateString()
  });
  res.json({ status: 'success' });
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('Servidor corriendo en puerto ' + PORT);
  console.log('Sesion: ' + authDir);
  console.log('URL: ' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:' + PORT));
});