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
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.static(__dirname));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const authDir = process.env.AUTH_DIR || path.join(__dirname, 'sesion_whatsapp');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
const datosDir = process.env.DATA_DIR || authDir;
const archivoDatos = path.join(datosDir, 'datos_validador.json');
console.log('Sesion WhatsApp guardada en: ' + authDir);
console.log('Uploads en: ' + uploadDir);
console.log('Datos persistentes en: ' + archivoDatos);
let pagosBD = [];
let smsBancoBD = [];
let clientesInstruidos = [];
let sockWhatsApp = null;
let ultimoQrGenerado = '';
let isConnecting = false;
let estadoConexion = 'iniciando';
let ultimoError = '';
let intentosConexion = 0;
const MAX_INTENTOS = 5;
const OCR_TIMEOUT_MS = 90000;
// ==========================================
// PERSISTENCIA DE DATOS
// ==========================================
function cargarDatos() {
try {
if (fs.existsSync(archivoDatos)) {
const raw = fs.readFileSync(archivoDatos, 'utf8');
const data = JSON.parse(raw);
if (Array.isArray(data.pagos)) pagosBD = data.pagos;
if (Array.isArray(data.sms)) smsBancoBD = data.sms;
if (Array.isArray(data.clientesInstruidos)) clientesInstruidos = data.clientesInstruidos;
console.log('[DATOS] Cargados ' + pagosBD.length + ' pagos y ' + smsBancoBD.length + ' avisos');
} else {
console.log('[DATOS] Sin archivo previo, iniciando vacio');
}
} catch (e) {
console.error('[DATOS] Error cargando: ' + e.message);
}
}
let guardandoPendiente = null;
function guardarDatos() {
if (guardandoPendiente) clearTimeout(guardandoPendiente);
guardandoPendiente = setTimeout(function() {
try {
const data = { pagos: pagosBD, sms: smsBancoBD, clientesInstruidos: clientesInstruidos, guardado: new Date().toISOString() };
fs.writeFileSync(archivoDatos, JSON.stringify(data), 'utf8');
} catch (e) {
console.error('[DATOS] Error guardando: ' + e.message);
}
}, 400);
}
cargarDatos();
// ==========================================
// UTILIDADES
// ==========================================
function quitarAcentos(s) {
return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function conTimeout(promesa, ms, etiqueta) {
let temporizador;
const limite = new Promise(function(resolve, reject) {
temporizador = setTimeout(function() {
reject(new Error('Tiempo agotado en ' + etiqueta));
}, ms);
});
return Promise.race([promesa, limite]).finally(function() {
clearTimeout(temporizador);
});
}
function normalizarRef(ref) {
if (!ref) return '';
return String(ref).replace(/\D/g, '').replace(/^0+/, '');
}
// ==========================================
// BUSQUEDA DE PAGO DUPLICADO POR REFERENCIA
// ==========================================
function buscarPagoDuplicadoPorRef(ref) {
const refN = normalizarRef(ref);
if (!refN) return null;
for (let i = 0; i < pagosBD.length; i++) {
const p = pagosBD[i];
const pN = normalizarRef(p.ref);
if (!pN) continue;
if (pN === refN) return p;
if (pN.length >= 8 && refN.length >= 8 && pN.slice(-8) === refN.slice(-8)) return p;
}
return null;
}
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
// DETECCION DE BANCO POR CODIGO DE CUENTA
// ==========================================
function detectarBancoPorCodigoCuenta(texto) {
if (!texto) return null;
const cuentas = texto.match(/\b(0\d{3})\d{16}\b/g) || [];
const cuentasCortas = texto.match(/\b(0\d{3})[\s-]?\d{4}[\s-]?\d{2}[\s-]?\d{8,10}\b/g) || [];
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
/N[UÚ]MERO\s+DE\s+REFERENCIA[:\s]+(\d{8,15})/i,
/NUMERO\s+DE\s+REFERENCIA[:\s]+(\d{8,15})/i,
/Operaci[oó]n[:\s]+(\d{8,15})/i,
/(\d{8,12})\s+Pago/i,
/Ref\.?\s+del?\s+abono[^\d]{0,50}(\d{6,15})/i,
/Ref\.?\s+de\s+abono[^\d]{0,50}(\d{6,15})/i,
/REFERENCIA[^\d]{0,20}(\d{10,14})/i,
/\b(06\d{10})\b/,
/(?:ref\.?|referencia|nro\.?\s+ref|n[uú]mero\s+de\s+referencia)[^\d]{0,25}(\d{8,15})/i,
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
// NORMALIZACION DE MONTOS (CORREGIDO: /\./g)
// ==========================================
function normalizarMontoVE(str) {
if (!str) return 0;
let limpio = String(str).replace(/\s/g, '');
if (limpio.indexOf(',') !== -1) {
limpio = limpio.replace(/\./g, '').replace(',', '.');
} else {
const partes = limpio.split('.');
if (partes.length > 1 && partes[partes.length - 1].length === 2) {
const dec = partes.pop();
limpio = partes.join('') + '.' + dec;
} else if (partes.length > 1) {
limpio = partes.join('');
}
}
const num = parseFloat(limpio);
return isNaN(num) ? 0 : num;
}
// ==========================================
// EXTRACCION DE MONTO (MEJORADO PARA TABLAS BDV)
// ==========================================
function extraerMonto(texto) {
if (!texto) return 0.00;
const limpio = texto.replace(/\s+/g, ' ');
// Patron 1: con etiqueta Bs (Bs. 264.174,66)
const matchBs = limpio.match(/Bs\.?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i);
if (matchBs) {
const monto = normalizarMontoVE(matchBs[1]);
if (monto > 0 && monto < 999999999) return monto;
}
// Patron 2: etiqueta Monto/Total seguida del numero
const matchEtiqueta = limpio.match(/(?:monto|total|importe|valor|bol[ií]vares?)[^\d]{0,15}(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?)/i);
if (matchEtiqueta) {
const monto = normalizarMontoVE(matchEtiqueta[1]);
if (monto > 0 && monto < 999999999) return monto;
}
// Patron 3: formato tabla BDV sin etiqueta (264.174,66)
const matchTabla = limpio.match(/\b(\d{1,3}(?:\.\d{3})+,\d{2})\b/);
if (matchTabla) {
const monto = normalizarMontoVE(matchTabla[1]);
if (monto > 0 && monto < 999999999) return monto;
}
// Patron 4: numero simple con coma decimal (150,00)
const matchSimple = limpio.match(/\b(\d{1,9},\d{2})\b/);
if (matchSimple) {
const monto = normalizarMontoVE(matchSimple[1]);
if (monto > 0 && monto < 999999999) return monto;
}
// Patron 5: formato con punto decimal (150.00)
const matchPunto = limpio.match(/\b(\d{1,3}(?:,\d{3})+\.\d{2})\b/);
if (matchPunto) {
const monto = parseFloat(matchPunto[1].replace(/,/g, ''));
if (!isNaN(monto) && monto > 0 && monto < 999999999) return monto;
}
return 0.00;
}
// ==========================================
// EXTRACCION DE FECHA
// ==========================================
// ==========================================
// EXTRACCION DE FECHA
// ==========================================
function extraerFecha(texto) {
if (!texto) return '';
let match = texto.match(/(\d{2}[-/.]\d{2}[-/.]\d{4})/);
if (match) return match[1].replace(/[-.]/g, '/');
match = texto.match(/(\d{2}):(\d{2}):(\d{4})/);
if (match) return match[1] + '/' + match[2] + '/' + match[3];
match = texto.match(/(\d{2}[-/.]\d{2}[-/.]\d{2})\b/);
if (match) {
const partes = match[1].replace(/[-.]/g, '/').split('/');
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
/pago\sm[oó]vil\s+(?:desde|de)?[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\s+(?:a|para|por)|\n|$)/i,
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
// FILTRO: SOLO COMPROBANTES BANCARIOS
// ==========================================
function analizarComprobante(texto) {
const resultado = {
valido: false,
motivo: '',
puntos: 0,
tipo: 'desconocido',
anclasFuertes: [],
anclasDebiles: [],
senalesDocumento: []
};
if (!texto || texto.replace(/\s/g, '').length < 15) {
resultado.motivo = 'La imagen no tiene texto legible suficiente';
return resultado;
}
const base = quitarAcentos(texto.toLowerCase());
const lineas = base.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
const etiquetaConcepto = /^(concepto|descripcion|motivo|observacion|observaciones|nota|comentario|detalle|asunto)\b/;
const lineasDocumento = [];
let saltarSiguiente = false;
for (let i = 0; i < lineas.length; i++) {
const linea = lineas[i];
if (etiquetaConcepto.test(linea)) {
const resto = linea.replace(etiquetaConcepto, '').replace(/[:-\s]/g, '');
if (resto.length === 0) saltarSiguiente = true;
continue;
}
if (saltarSiguiente) {
saltarSiguiente = false;
continue;
}
lineasDocumento.push(linea);
}
const doc = lineasDocumento.join('\n');
const plano = doc.replace(/\s+/g, ' ');
const compacto = doc.replace(/\s/g, '');
const listaFuertes = [
[/\bpago\s*movil\b/, 'pago movil'],
[/\bcomprobante\b/, 'comprobante'],
[/\b(?:nro|no|num|numero)\.?\s*(?:de\s*)?(?:referencia|operacion|control)\b/, 'nro referencia/operacion'],
[/\breferencia\s*[:#]?\s*\d{6,}/, 'referencia con numero'],
[/\b(?:operacion|transaccion|pago|transferencia|envio)\s*(?:exitos[oa]|aprobad[oa]|realizad[oa]|procesad[oa]|enviad[oa]|recibid[oa]|efectuad[oa])\b/, 'operacion exitosa'],
[/\b(?:exitos[oa]|aprobad[oa])\s*!/, 'estado exitoso'],
[/\bbdv\s*(?:en\s*linea|movil|app)\b/, 'BDV en linea'],
[/\bpago\s*bdv\b/, 'Pago BDV'],
[/\bbanesco\s*(?:movil|en\s*linea)\b/, 'Banesco movil'],
[/\bprovipay\b/, 'Provipay'],
[/\btpago\b/, 'Tpago'],
[/\bmercantil\s*(?:en\s*linea|movil)\b/, 'Mercantil en linea'],
[/\bbancamiga\s*(?:movil|app)\b/, 'Bancamiga movil'],
[/\bbanplus\s*(?:movil|app)\b/, 'Banplus movil'],
[/\brecibo\s+de\s+(?:pago|transferencia)\b/, 'recibo de pago'],
[/\b(?:cuenta|telefono)\s*(?:origen|destino)\b/, 'cuenta/telefono origen-destino'],
[/\bbeneficiario\b/, 'beneficiario'],
[/\bconsulta\s+de\s+creditos\b/, 'consulta de creditos BDV'],
[/\bpago\s+exitoso\b/, 'pago exitoso']
];
for (const par of listaFuertes) {
if (par[0].test(plano)) resultado.anclasFuertes.push(par[1]);
}
const listaDebiles = [
[/\btransferencia\b/, 'transferencia'],
[/\breferencia\b/, 'referencia'],
[/\bbanco\b/, 'palabra banco'],
[/\bbdv\b/, 'bdv'],
[/\bbanesco\b/, 'banesco'],
[/\bmercantil\b/, 'mercantil'],
[/\bprovincial\b/, 'provincial'],
[/\bbancamiga\b/, 'bancamiga'],
[/\bbanplus\b/, 'banplus'],
[/\bbancaribe\b/, 'bancaribe'],
[/\bbancrecer\b/, 'bancrecer'],
[/\bsofitasa\b/, 'sofitasa'],
[/\bbangente\b/, 'bangente'],
[/\btesoro\b/, 'tesoro'],
[/\bexterior\b/, 'exterior'],
[/\bcaroni\b/, 'caroni'],
[/\bplaza\b/, 'plaza'],
[/\bactivo\b/, 'activo'],
[/\bmi\s*banco\b/, 'mi banco'],
[/\bnacional\s+de\s+credito\b/, 'bnc'],
[/\bfondo\s*comun\b/, 'fondo comun'],
[/\bmonto\b/, 'monto'],
[/\bbs\.?\b/, 'bs'],
[/\bbolivares\b/, 'bolivares'],
[/\babono\b/, 'abono'],
[/\bdeposito\b/, 'deposito'],
[/\bcedula\b/, 'cedula'],
[/\bfecha\s*(?:de\s*)?(?:operacion|transaccion|pago)\b/, 'fecha de operacion']
];
for (const par of listaDebiles) {
if (par[0].test(plano)) resultado.anclasDebiles.push(par[1]);
}
const tieneReferencia = /\b\d{6,15}\b/.test(plano);
const tieneMonto = /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/.test(plano);
const tieneCuenta = /\b0\d{19}\b/.test(compacto);
const tieneTelefono = /\b0(?:412|414|416|424|426|212)\d{7}\b/.test(compacto);
const tieneDatosPago = tieneReferencia || tieneMonto;
const senales = [];
if (/\bsub\s+total\b/.test(plano)) senales.push('subtotal');
if (/\biva\b/.test(plano) || /\bi\.v\.a\b/.test(plano)) senales.push('iva');
if (/\b(?:factura|proforma|presupuesto|cotizacion)\s+(?:n|no|nro|numero|#|:)/.test(plano)) senales.push('factura nro');
if (/^\s*(factura|presupuesto|cotizacion|proforma)\s*$/m.test(doc)) senales.push('titulo factura');
if (/\borden\s*(?:de\s*)?(?:servicio|compra|trabajo|pedido)\b/.test(plano)) senales.push('orden de servicio');
if (/\bnota\s+de\s+(?:entrega|pedido)\b/.test(plano)) senales.push('nota de entrega');
if (/\btotal\s+a\s+pagar\b/.test(plano)) senales.push('total a pagar');
if (/\bsaldo\s*(?:pendiente|deudor|anterior)\b/.test(plano)) senales.push('saldo pendiente');
if (/\bcondiciones\s+de\s+pago\b/.test(plano)) senales.push('condiciones de pago');
if (/\bfecha\s+de\s+(?:emision|vencimiento)\b/.test(plano)) senales.push('fecha emision');
if (/\brif\s*[:-]?\s*[jvgpe]\s*-?\s*\d/.test(plano)) senales.push('rif emisor');
if (/\bcant(?:idad)?\b/.test(plano) && /\b(?:p\.?\s*unit|precio\s+unit|unitario|importe)\b/.test(plano)) senales.push('tabla cantidad/precio');
if (/\bdescripcion\b/.test(plano) && /\b(?:unidad|medida|sku|codigo\s*producto)\b/.test(plano)) senales.push('tabla productos');
resultado.senalesDocumento = senales;
const fuertes = resultado.anclasFuertes.length;
const debiles = resultado.anclasDebiles.length;
resultado.puntos = (fuertes * 3) + debiles + (tieneReferencia ? 2 : 0) + (tieneMonto ? 2 : 0) + (tieneCuenta ? 3 : 0) + (tieneTelefono ? 1 : 0);
if (/\bpago\s*movil\b/.test(plano) || /\bprovipay\b/.test(plano) || /\btpago\b/.test(plano)) {
resultado.tipo = 'pago_movil';
} else if (/\btransferencia\b/.test(plano) || /\bconsulta\s+de\s+creditos\b/.test(plano)) {
resultado.tipo = 'transferencia';
} else if (/\bdeposito\b/.test(plano)) {
resultado.tipo = 'deposito';
}
if (fuertes >= 1 && tieneDatosPago) {
resultado.valido = true;
resultado.motivo = 'Comprobante bancario verificado (' + resultado.anclasFuertes.slice(0, 3).join(', ') + ')';
return resultado;
}
if (senales.length >= 2 && fuertes === 0) {
resultado.valido = false;
resultado.motivo = 'Parece factura u orden de servicio (' + senales.slice(0, 3).join(', ') + ')';
return resultado;
}
const tieneEntidad = debiles >= 1 && (/\bbanco\b/.test(plano) || /\bbdv\b/.test(plano) || /\bbanesco\b/.test(plano) || /\bmercantil\b/.test(plano) || /\bprovincial\b/.test(plano) || /\bbancamiga\b/.test(plano) || /\bbanplus\b/.test(plano) || /\bbancaribe\b/.test(plano) || tieneCuenta);
if (tieneEntidad && tieneDatosPago && senales.length === 0) {
resultado.valido = true;
resultado.motivo = 'Comprobante bancario aceptado por entidad + datos de pago';
return resultado;
}
if (!tieneDatosPago) {
resultado.motivo = 'No se detecto referencia ni monto de pago';
} else if (senales.length >= 1 && fuertes === 0) {
resultado.motivo = 'Documento no bancario (' + senales[0] + ') sin datos de operacion bancaria';
} else {
resultado.motivo = 'No se identifico una operacion bancaria (pago movil, transferencia o comprobante)';
}
resultado.valido = false;
return resultado;
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
.grayscale().normalize().sharpen({ sigma: 1.5 }).threshold(128)
.png({ compressionLevel: 6 }).toFile(rutaNormal);
await sharp(rutaOriginal)
.resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: false })
.negate().grayscale().normalize().sharpen({ sigma: 1.5 }).threshold(128)
.png({ compressionLevel: 6 }).toFile(rutaInvertida);
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
console.log('[OCR] Proceso completado. Caracteres: ' + (textoNormal.length + textoInvertido.length));
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
// PARSER DE NOTIFICACIONES BDV
// ==========================================
function parsearNotificacionBDV(texto) {
const r = {
valido: false,
tipo: 'desconocido',
nombre: '',
telefono: '',
monto: 0,
referencia: '',
fecha: '',
motivo: ''
};
if (!texto || typeof texto !== 'string') {
r.motivo = 'Texto vacio';
return r;
}
const t = quitarAcentos(texto.replace(/\s+/g, ' ').trim());
const lower = t.toLowerCase();
if (/pagomovil|pago movil/.test(lower)) {
r.tipo = 'pago_movil';
} else if (/transferencia/.test(lower)) {
r.tipo = 'transferencia';
} else if (/deposito/.test(lower)) {
r.tipo = 'deposito';
}
const mMonto = t.match(/Bs\.?\s*([\d.,]+)/i);
if (mMonto) {
const n = normalizarMontoVE(mMonto[1]);
if (n > 0) r.monto = Math.round(n * 100) / 100;
}
const mTel = t.match(/\b(04(?:12|14|16|24|26))[\s-.]?(\d{7})\b/);
if (mTel) r.telefono = mTel[1] + '-' + mTel[2];
if (!r.telefono) {
const mTel2 = t.match(/\b(02\d{2})[\s-.]?(\d{7})\b/);
if (mTel2) r.telefono = mTel2[1] + '-' + mTel2[2];
}
const mRef = t.match(/(?:ref(?:erencia)?|numero\s+de\s+operacion|nro\.?\s+de\s+operacion|num\.?\s+de\s+operacion|numero\s+de\s+referencia|operacion|control)\s*[:.#]?\s*(\d{6,20})/i);
if (mRef) {
r.referencia = mRef[1];
} else {
let sinRuido = t.replace(/Bs\.?\s*[\d.,]+/i, ' ');
if (r.telefono) sinRuido = sinRuido.replace(r.telefono, ' ');
const mRef2 = sinRuido.match(/\b(\d{8,20})\b/);
if (mRef2) r.referencia = mRef2[1];
}
const mNombre = t.match(/\bde\s+([A-Z][A-Za-z\s.]{3,60}?)\s+por\s+Bs/i);
if (mNombre) r.nombre = mNombre[1].trim().replace(/\s+/g, ' ');
const mHora = t.match(/hora\s*[:.]?\s*(\d{1,2}:\d{2})/i);
const mFechaCorta = t.match(/fecha\s*[:.]?\s*(\d{2})[/-](\d{2})[/-](\d{2,4})/i);
if (mFechaCorta) {
let anio = mFechaCorta[3];
if (anio.length === 2) anio = '20' + anio;
r.fecha = mFechaCorta[1] + '/' + mFechaCorta[2] + '/' + anio;
if (mHora) r.fecha = r.fecha + ' ' + mHora[1];
}
if (!r.fecha) {
const mFecha = t.match(/(\d{2})[/-](\d{2})[/-](\d{4})(?:\s+(\d{1,2}:\d{2})(?:\s*([APap]\.?[Mm]\.?))?)?/);
if (mFecha) {
r.fecha = mFecha[1] + '/' + mFecha[2] + '/' + mFecha[3];
if (mFecha[4]) r.fecha = r.fecha + ' ' + mFecha[4] + (mFecha[5] ? ' ' + mFecha[5].toUpperCase() : '');
}
}
if (!r.monto && !r.referencia) {
r.motivo = 'No se detecto monto ni referencia';
return r;
}
if (!r.monto) {
r.motivo = 'No se detecto el monto';
return r;
}
if (!r.referencia) {
r.motivo = 'No se detecto la referencia';
return r;
}
const esRecibido = /recibiste|recibido|recibida|abono|pago recibido/.test(lower);
if (!esRecibido && r.tipo === 'desconocido') {
r.motivo = 'Tiene monto y referencia pero no se identifica el tipo de operacion';
return r;
}
r.valido = true;
r.motivo = 'Notificacion BDV valida';
return r;
}
function buscarPagoPorNotificacion(notif) {
const refN = normalizarRef(notif.referencia);
let i;
for (i = 0; i < pagosBD.length; i++) {
const p = pagosBD[i];
if (p.estado === 'aprobado') continue;
const pN = normalizarRef(p.ref);
if (!pN || !refN) continue;
if (pN === refN) return { pago: p, criterio: 'referencia exacta' };
if (pN.length >= 8 && refN.length >= 8 && pN.slice(-8) === refN.slice(-8)) {
return { pago: p, criterio: 'ultimos 8 digitos' };
}
}
const candidatos = pagosBD.filter(function(p) {
return p.estado !== 'aprobado' && Math.abs((parseFloat(p.monto) || 0) - notif.monto) < 0.01;
});
if (candidatos.length === 1) return { pago: candidatos[0], criterio: 'monto exacto' };
return null;
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
const respaldo = path.join(datosDir, 'datos_validador.json');
const existeRespaldo = fs.existsSync(respaldo);
let contenidoRespaldo = null;
if (existeRespaldo) {
try { contenidoRespaldo = fs.readFileSync(respaldo, 'utf8'); } catch (e) {}
}
fs.rmSync(authDir, { recursive: true, force: true });
fs.mkdirSync(authDir, { recursive: true });
if (contenidoRespaldo) {
try { fs.writeFileSync(respaldo, contenidoRespaldo, 'utf8'); } catch (e) {}
}
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
const jidReal = msg.key.remoteJidAlt || msg.key.participantAlt || remitente;
const esLid = String(remitente).indexOf('@lid') !== -1 && String(jidReal).indexOf('@s.whatsapp.net') === -1;
const telefonoLimpio = esLid ? '' : String(jidReal).split('@')[0].replace(/[^0-9]/g, '');
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
// Solo la PRIMERA vez se envian las instrucciones
if (clientesInstruidos.indexOf(remitente) === -1) {
clientesInstruidos.push(remitente);
guardarDatos();
await sockWhatsApp.sendMessage(remitente, {
text: 'Hola Sr(a) ' + nombreCliente + '\n\nSi necesita informacion sera contactado a la brevedad por uno de nuestros operadores.\n\nSi esta intentando reportar un pago, por favor envie una imagen del comprobante o escriba:\nRef: 12345678 Monto: Bs. XXX,00'
});
}
return;
}
// VERIFICAR DUPLICADO POR REFERENCIA
const pagoExistente = buscarPagoDuplicadoPorRef(ref);
if (pagoExistente) {
pagoExistente.cliente = nombreCliente;
pagoExistente.telefono = telefonoLimpio ? '+' + telefonoLimpio : pagoExistente.telefono;
pagoExistente.remitenteJid = remitente;
pagoExistente.fechaEdicion = new Date().toLocaleString();
pagoExistente.origen = pagoExistente.origen === 'banco' ? 'banco_con_whatsapp' : 'whatsapp_texto';
pagoExistente.sinComprobante = false;
if (monto > 0) pagoExistente.monto = monto;
if (bancoDetectado && bancoDetectado !== 'Por confirmar') pagoExistente.banco = bancoDetectado;
if (fechaComprobante) pagoExistente.fecha = fechaComprobante;
guardarDatos();
console.log('[DEDUP] Texto vinculado al pago existente ID ' + pagoExistente.id + ' Ref ' + ref);
await sockWhatsApp.sendMessage(remitente, {
text: 'Comprobante recibido y vinculado a un pago ya registrado.\n\nDatos:\n- Ref: ' + (ref || 'No detectada') + '\n- Monto: Bs. ' + (pagoExistente.monto || monto).toFixed(2) + '\n- Banco: ' + pagoExistente.banco + '\n\nPronto validaremos.'
});
return;
}
pagosBD.unshift({
id: Date.now(),
cliente: nombreCliente,
telefono: telefonoLimpio ? '+' + telefonoLimpio : '',
ref: ref || 'SIN_REF',
monto: monto,
banco: bancoDetectado,
estado: 'pendiente',
fecha: fechaComprobante || new Date().toLocaleString(),
remitenteJid: remitente,
imagen: null,
textoOCR: textoPlano.substring(0, 600),
origen: 'whatsapp_texto'
});
guardarDatos();
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
const analisis = analizarComprobante(textoOCR);
console.log('[FILTRO] Puntos: ' + analisis.puntos + ' | Valido: ' + analisis.valido + ' | Motivo: ' + analisis.motivo);
if (!analisis.valido) {
try { fs.unlinkSync(rutaCompleta); } catch (e) {}
console.log('[FILTRO] Imagen RECHAZADA y eliminada: ' + nombreArchivo);
try {
await sockWhatsApp.sendMessage(remitente, {
text: 'Esta imagen NO es un comprobante de pago bancario.\n\nMotivo: ' + analisis.motivo + '\n\nSolo aceptamos capturas de:\n- Pago Movil\n- Transferencia bancaria\n- Deposito\n\nSi crees que es un error, envia los datos por texto:\nRef: 12345678 Monto: Bs. 123,00'
});
} catch (e) {}
return;
}
const ref = extraerReferencia(textoOCR);
const monto = extraerMonto(textoOCR);
const fechaComprobante = extraerFecha(textoOCR);
const bancoDetectado = extraerBanco(textoOCR);
console.log('[WHATSAPP] Banco: ' + bancoDetectado + ' | Ref: ' + (ref || 'SIN_REF') + ' | Monto: ' + monto);
// VERIFICAR DUPLICADO POR REFERENCIA
const pagoExistente = buscarPagoDuplicadoPorRef(ref);
if (pagoExistente) {
pagoExistente.cliente = nombreCliente;
pagoExistente.telefono = telefonoLimpio ? '+' + telefonoLimpio : pagoExistente.telefono;
pagoExistente.remitenteJid = remitente;
pagoExistente.imagen = nombreArchivo;
pagoExistente.tipoOperacion = analisis.tipo;
pagoExistente.puntuacionComprobante = analisis.puntos;
pagoExistente.textoOCR = (textoOCR || 'OCR sin resultado').substring(0, 600);
pagoExistente.fechaEdicion = new Date().toLocaleString();
pagoExistente.origen = pagoExistente.origen === 'banco' ? 'banco_con_whatsapp' : 'whatsapp_imagen';
pagoExistente.sinComprobante = false;
if (monto > 0) pagoExistente.monto = monto;
if (bancoDetectado && bancoDetectado !== 'Por confirmar') pagoExistente.banco = bancoDetectado;
if (fechaComprobante) pagoExistente.fecha = fechaComprobante;
guardarDatos();
console.log('[DEDUP] Imagen vinculada al pago existente ID ' + pagoExistente.id + ' Ref ' + ref);
try {
await sockWhatsApp.sendMessage(remitente, {
text: 'Comprobante procesado y vinculado a un pago ya registrado.\n\nDatos:\n- Ref: ' + (ref || 'No detectada') + '\n- Monto: Bs. ' + (pagoExistente.monto || monto).toFixed(2) + '\n- Banco: ' + pagoExistente.banco + '\n\nPronto validaremos.'
});
} catch (e) {
console.error('[WHATSAPP] Error enviando confirmacion: ' + e.message);
}
return;
}
pagosBD.unshift({
id: Date.now(),
cliente: nombreCliente,
telefono: telefonoLimpio ? '+' + telefonoLimpio : '',
ref: ref || 'SIN_REF',
monto: monto,
banco: bancoDetectado,
estado: 'pendiente',
fecha: fechaComprobante || new Date().toLocaleString(),
remitenteJid: remitente,
imagen: nombreArchivo,
tipoOperacion: analisis.tipo,
puntuacionComprobante: analisis.puntos,
textoOCR: (textoOCR || 'OCR sin resultado').substring(0, 600),
origen: 'whatsapp_imagen'
});
guardarDatos();
try {
await sockWhatsApp.sendMessage(remitente, {
text: 'Comprobante procesado.\n\nDatos:\n- Ref: ' + (ref || 'No detectada') + '\n- Monto: Bs. ' + monto.toFixed(2) + '\n- Banco: ' + bancoDetectado + '\n\nPronto validaremos.'
});
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
archivoDatos: archivoDatos,
datosExisten: fs.existsSync(archivoDatos),
uptime: process.uptime(),
pagos: pagosBD.length,
sms: smsBancoBD.length
});
});
app.get('/api/diagnostico', function(req, res) {
res.json({
quitarAcentos: typeof quitarAcentos,
parsearNotificacionBDV: typeof parsearNotificacionBDV,
normalizarRef: typeof normalizarRef,
buscarPagoPorNotificacion: typeof buscarPagoPorNotificacion,
buscarPagoDuplicadoPorRef: typeof buscarPagoDuplicadoPorRef,
analizarComprobante: typeof analizarComprobante,
extraerMonto: typeof extraerMonto,
extraerReferencia: typeof extraerReferencia,
guardarDatos: typeof guardarDatos,
pagosRegistrados: pagosBD.length,
smsRegistrados: smsBancoBD.length,
clientesInstruidos: clientesInstruidos.length,
estadoWhatsApp: estadoConexion
});
});
// Endpoint de prueba: verificar lectura de monto y referencia de un texto
app.get('/api/probar-lectura', function(req, res) {
const texto = req.query.texto || '';
res.json({
texto: texto,
referencia: extraerReferencia(texto),
monto: extraerMonto(texto),
fecha: extraerFecha(texto),
banco: extraerBanco(texto)
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
guardarDatos();
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
guardarDatos();
res.json({ status: 'success', id: id, estado: estado });
});
app.patch('/api/pagos/:id/editar', function(req, res) {
const id = parseInt(req.params.id);
const pago = pagosBD.find(function(p) { return p.id === id; });
if (!pago) {
return res.status(404).json({ status: 'error', message: 'Pago no encontrado' });
}
if (req.body.ref !== undefined) pago.ref = req.body.ref;
if (req.body.monto !== undefined) pago.monto = parseFloat(req.body.monto) || 0;
if (req.body.cliente !== undefined) pago.cliente = req.body.cliente;
if (req.body.telefono !== undefined) pago.telefono = req.body.telefono;
if (req.body.telefonoPagador !== undefined) pago.telefonoPagador = req.body.telefonoPagador;
if (req.body.pagadorBanco !== undefined) pago.pagadorBanco = req.body.pagadorBanco;
if (req.body.banco !== undefined) pago.banco = req.body.banco;
if (req.body.estado !== undefined) pago.estado = req.body.estado;
pago.fechaEdicion = new Date().toLocaleString();
guardarDatos();
res.json({ status: 'success', id: id });
});
app.delete('/api/pagos/:id', function(req, res) {
const id = parseInt(req.params.id);
const indice = pagosBD.findIndex(function(p) { return p.id === id; });
if (indice === -1) {
return res.status(404).json({ status: 'error', message: 'Pago no encontrado' });
}
const pagoEliminado = pagosBD[indice];
if (pagoEliminado.imagen) {
const rutaImg = path.join(uploadDir, pagoEliminado.imagen);
if (fs.existsSync(rutaImg)) {
try { fs.unlinkSync(rutaImg); } catch (e) {}
}
}
pagosBD.splice(indice, 1);
guardarDatos();
console.log('Pago eliminado ID: ' + id);
res.json({ status: 'success', id: id });
});
app.delete('/api/sms/:id', function(req, res) {
const id = parseInt(req.params.id);
const indice = smsBancoBD.findIndex(function(s) { return s.id === id; });
if (indice === -1) {
return res.status(404).json({ status: 'error', message: 'Aviso no encontrado' });
}
smsBancoBD.splice(indice, 1);
guardarDatos();
res.json({ status: 'success', id: id });
});
app.get('/qr', function(req, res) {
res.sendFile(path.join(__dirname, 'qr.html'));
});
// ==========================================
// WEBHOOK DEL BANCO
// ==========================================
app.post('/webhook/sms-banco', function(req, res) {
try {
const tokenEsperado = process.env.WEBHOOK_TOKEN || '';
let cuerpo = req.body;
if (typeof cuerpo === 'string') cuerpo = { texto: cuerpo };
if (!cuerpo || typeof cuerpo !== 'object') cuerpo = {};
const tokenRecibido = cuerpo.token || req.query.token || req.headers['x-token'] || '';
console.log('[BANCO-DEBUG] Token requerido: ' + (tokenEsperado ? 'SI' : 'NO') + ' | Recibido: ' + (tokenRecibido || 'ninguno') + ' | Coincide: ' + (tokenRecibido === tokenEsperado));
if (tokenEsperado && tokenRecibido !== tokenEsperado) {
console.log('[BANCO] RECHAZADO por token. Body: ' + JSON.stringify(cuerpo).substring(0, 300));
return res.status(401).json({ status: 'error', message: 'Token invalido' });
}
let texto = cuerpo.texto || cuerpo.text || cuerpo.message || cuerpo.sms || cuerpo.body || cuerpo.content || cuerpo.notificacion || cuerpo.notification || req.query.texto || '';
const titulo = cuerpo.titulo || cuerpo.title || '';
if (!texto) {
const valores = Object.keys(cuerpo).filter(function(k) {
return k !== 'token' && typeof cuerpo[k] === 'string' && cuerpo[k].length > 0;
}).map(function(k) { return cuerpo[k]; });
if (valores.length > 0) texto = valores.join(' ');
}
if (titulo && String(texto).indexOf(titulo) === -1) texto = titulo + ' ' + texto;
texto = String(texto).replace(/\s+/g, ' ').trim();
console.log('[BANCO-DEBUG] Texto final (' + texto.length + ' chars): ' + texto.substring(0, 400));
if (!texto) {
return res.status(400).json({ status: 'error', message: 'No se recibio texto' });
}
const notif = parsearNotificacionBDV(texto);
console.log('[BANCO] Tipo: ' + notif.tipo + ' | Monto: ' + notif.monto + ' | Ref: ' + notif.referencia + ' | Pagador: ' + (notif.nombre || 'sin nombre') + ' | Tel: ' + (notif.telefono || 'sin telefono') + ' | Valido: ' + notif.valido);
const registro = {
id: Date.now(),
texto: texto,
fecha: new Date().toLocaleString(),
fechaBanco: notif.fecha,
tipo: notif.tipo,
pagador: notif.nombre,
telefonoPagador: notif.telefono,
monto: notif.monto,
referencia: notif.referencia,
procesado: notif.valido,
motivo: notif.motivo
};
if (!notif.valido) {
smsBancoBD.unshift(registro);
guardarDatos();
return res.json({ status: 'info', message: notif.motivo, parseado: notif });
}
const yaExiste = smsBancoBD.find(function(s) {
return s.referencia && normalizarRef(s.referencia) === normalizarRef(notif.referencia);
});
if (yaExiste) {
return res.json({ status: 'duplicado', referencia: notif.referencia, message: 'Esta operacion ya fue registrada' });
}
// Si ya existe un pago (incluso aprobado) con esa referencia, no crear otro
const pagoDuplicado = buscarPagoDuplicadoPorRef(notif.referencia);
if (pagoDuplicado && pagoDuplicado.estado === 'aprobado') {
registro.pagoId = pagoDuplicado.id;
registro.conciliado = true;
smsBancoBD.unshift(registro);
guardarDatos();
console.log('[BANCO] Referencia ' + notif.referencia + ' ya aprobada en pago ' + pagoDuplicado.id + '. No se duplica.');
return res.json({ status: 'duplicado', conciliado: true, pagoId: pagoDuplicado.id, referencia: notif.referencia, message: 'Este pago ya estaba aprobado' });
}
const hallado = buscarPagoPorNotificacion(notif);
if (hallado) {
const pago = hallado.pago;
pago.estado = 'aprobado';
pago.monto = notif.monto;
pago.ref = notif.referencia;
pago.banco = 'Banco de Venezuela';
pago.tipoOperacion = notif.tipo;
if (notif.nombre) pago.pagadorBanco = notif.nombre;
if (notif.telefono) pago.telefonoPagador = notif.telefono;
pago.confirmadoPorBanco = true;
pago.criterioConciliacion = hallado.criterio;
pago.fechaBanco = notif.fecha;
pago.fechaAprobacion = new Date().toLocaleString();
registro.pagoId = pago.id;
registro.conciliado = true;
smsBancoBD.unshift(registro);
guardarDatos();
console.log('[BANCO] Pago ' + pago.id + ' aprobado por ' + hallado.criterio);
if (pago.remitenteJid && sockWhatsApp) {
sockWhatsApp.sendMessage(pago.remitenteJid, {
text: 'Pago CONFIRMADO por el banco.\n\nMonto: Bs. ' + notif.monto.toFixed(2) + '\nReferencia: ' + notif.referencia + '\n\nGracias por su pago.'
}).catch(function(e) {
console.error('[BANCO] Error notificando cliente: ' + e.message);
});
}
return res.json({ status: 'success', conciliado: true, criterio: hallado.criterio, pagoId: pago.id, referencia: notif.referencia, monto: notif.monto, pagador: notif.nombre, telefonoPagador: notif.telefono });
}
pagosBD.unshift({
id: Date.now() + 1,
cliente: notif.nombre || 'Pago recibido BDV',
telefono: '',
pagadorBanco: notif.nombre || '',
telefonoPagador: notif.telefono || '',
ref: notif.referencia,
monto: notif.monto,
banco: 'Banco de Venezuela',
tipoOperacion: notif.tipo,
estado: 'pendiente',
fecha: notif.fecha || new Date().toLocaleString(),
fechaBanco: notif.fecha,
remitenteJid: null,
imagen: null,
origen: 'banco',
sinComprobante: true,
confirmadoPorBanco: true,
textoOCR: 'Pago recibido segun notificacion BDV. Falta vincular con el cliente.'
});
smsBancoBD.unshift(registro);
guardarDatos();
console.log('[BANCO] Pago del banco registrado sin comprobante. Ref: ' + notif.referencia);
res.json({ status: 'success', conciliado: false, message: 'Pago del banco registrado. Vinculelo con el cliente.', referencia: notif.referencia, monto: notif.monto, pagador: notif.nombre, telefonoPagador: notif.telefono });
} catch (error) {
console.error('[BANCO] Error en webhook: ' + error.message);
res.status(500).json({ status: 'error', message: error.message });
}
});
app.get('/api/probar-notificacion', function(req, res) {
try {
const texto = req.query.texto || '';
res.json(parsearNotificacionBDV(texto));
} catch (e) {
res.status(500).json({ ok: false, error: e.message });
}
});
app.get('/api/test-banco', function(req, res) {
try {
const texto = req.query.texto || '';
res.json({ ok: true, resultado: parsearNotificacionBDV(texto) });
} catch (e) {
res.status(500).json({ ok: false, error: e.message });
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
guardarDatos();
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
process.on('SIGTERM', function() {
try {
fs.writeFileSync(archivoDatos, JSON.stringify({ pagos: pagosBD, sms: smsBancoBD, clientesInstruidos: clientesInstruidos }), 'utf8');
console.log('[DATOS] Guardado antes de apagar');
} catch (e) {}
process.exit(0);
});