1: const { webcrypto } = require('crypto');
2: globalThis.crypto = webcrypto;
3: const express = require('express');
4: const bodyParser = require('body-parser');
5: const cors = require('cors');
6: const fs = require('fs');
7: const path = require('path');
8: const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
9: const pino = require('pino');
10: const qrcodeTerminal = require('qrcode-terminal');
11: const qrcode = require('qrcode');
12: const { createWorker } = require('tesseract.js');
13: const sharp = require('sharp');
14: const app = express();
15: app.use(cors());
16: app.use(bodyParser.json({ limit: '10mb' }));
17: app.use(express.static(__dirname));
18: const uploadDir = path.join(__dirname, 'uploads');
19: if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
20: const authDir = process.env.AUTH_DIR || path.join(__dirname, 'sesion_whatsapp');
21: console.log(`\n🔐 Sesión WhatsApp guardada en: ${authDir}`);
22: console.log(`📂 Uploads en: ${uploadDir}\n`);
23: let pagosBD = [];
24: let smsBancoBD = [];
25: let sockWhatsApp = null;
26: let ultimoQrGenerado = "";
27: let isConnecting = false;
28: let estadoConexion = 'iniciando';
29: let ultimoError = '';
30: let intentosConexion = 0;
31: const MAX_INTENTOS = 5;
32: const CODIGOS_BANCO = {
33: '0102': 'Banco de Venezuela', '0104': 'Banco Venezolano de Crédito',
34: '0105': 'Provincial', '0108': 'Mercantil', '0114': 'Banco Caroní',
35: '0115': 'Banco Exterior', '0116': 'Banco Occidental de Descuento',
36: '0128': 'Banco del Caribe', '0134': 'Banesco', '0137': 'Banco Sofitasa',
37: '0138': 'Banco Plaza', '0146': 'Bangente', '0151': 'Banco Fondo Común',
38: '0156': '100% Banco', '0157': 'Banco del Sur', '0163': 'Banco del Microempresario',
39: '0166': 'Banco Activo', '0168': 'Bancrecer', '0169': 'Mi Banco',
40: '0171': 'Banco Nacional de Crédito', '0172': 'Bancamiga', '0174': 'Banplus',
41: '0175': 'Bancaribe', '0177': 'Banco de la Fuerza Armada', '0191': 'Banco del Tesoro'
42: };
43: const LISTA_BANCOS = Object.values(CODIGOS_BANCO);
44: function detectarBancoPorCodigoCuenta(texto) {
45: if (!texto) return null;
46: const cuentas = texto.match(/\b(0\d{3})\d{16}\b/g) || [];
47: const cuentasCortas = texto.match(/\b(0\d{3})[\s\-]?\d{4}[\s\-]?\d{2}[\s\-]?\d{8,10}\b/g) || [];
48: const todas = [...cuentas, ...cuentasCortas];
49: for (const cuenta of todas) {
50: const codigo = cuenta.substring(0, 4);
51: if (CODIGOS_BANCO[codigo]) {
52: console.log(`🏦 Banco detectado por código ${codigo}: ${CODIGOS_BANCO[codigo]}`);
53: return CODIGOS_BANCO[codigo];
54: }
55: }
56: return null;
57: }
58: function extraerReferencia(texto) {
59: if (!texto) return "";
60: const limpio = texto.replace(/\s+/g, ' ').replace(/[|]/g, 'I');
61: const patrones = [
62: /N[UÚ]MERO\s*DE\s*REFERENCIA[:\s]*(\d{8,15})/i,
63: /NUMERO\s*DE\s*REFERENCIA[:\s]*(\d{8,15})/i,
64: /Operaci[oó]n[:\s]*(\d{8,15})/i,
65: /(\d{8,12})\s+Pago/i,
66: /Ref\.?\s*del?\s*abono[^\d]{0,50}(\d{6,15})/i,
67: /Ref\.?\s*de\s*abono[^\d]{0,50}(\d{6,15})/i,
68: /REFERENCIA[^\d]{0,20}(\d{10,14})/i,
69: /\b(06\d{10})\b/,
70: /(?:ref\.?|referencia|nro\.?\s*ref|n[uú]mero\s*de\s*referencia)[^\d]{0,25}(\d{8,15})/i,
71: /#\s*(\d{8,15})/i,
72: /(?:nro\.?|n[uú]m\.?|n[uú]mero)\s*(?:de\s*)?(?:referencia|operaci[oó]n|control)[^\d]{0,15}(\d{8,15})/i
73: ];
74: for (const patron of patrones) {
75: const match = limpio.match(patron);
76: if (match && match[1]) {
77: const ref = match[1].trim();
78: if (ref.startsWith('V') || ref.startsWith('J') || ref.startsWith('E')) continue;
79: if (ref.length === 11 && (ref.startsWith('0414') || ref.startsWith('0424') || ref.startsWith('0412') || ref.startsWith('0416') || ref.startsWith('0426'))) continue;
80: if (ref.length >= 18 && (ref.startsWith('0102') || ref.startsWith('0134') || ref.startsWith('0105'))) continue;
81: if (ref === '52477538' || ref === '12886291') continue;
82: if (ref.length >= 8 && ref.length <= 14) {
83: console.log(`✅ Referencia detectada: ${ref}`);
84: return ref;
85: }
86: }
87: }
88: const numerosLargos = limpio.match(/\b(\d{10,14})\b/g) || [];
89: for (const num of numerosLargos) {
90: if (num.length >= 8 && num.length <= 14 &&
91: !num.startsWith('0414') && !num.startsWith('0424') &&
92: !num.startsWith('0412') && !num.startsWith('0416') &&
93: !num.startsWith('0426') && !num.startsWith('0212')) {
94: console.log(`✅ Referencia (fallback): ${num}`);
95: return num;
96: }
97: }
98: return "";
99: }
100: function normalizarMontoVE(str) {
101: if (!str) return 0;
102: let limpio = str.replace(/\s/g, '').replace(/./g, '').replace(',', '.');
103: const num = parseFloat(limpio);
104: return isNaN(num) ? 0 : num;
105: }
106: function extraerMonto(texto) {
107: if (!texto) return 0.00;
108: const limpio = texto.replace(/\s+/g, ' ');
109: const matchPersonal = limpio.match(/\b(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:Bs|bs|BS)?\b/);
110: if (matchPersonal) {
111: const monto = normalizarMontoVE(matchPersonal[1]);
112: if (monto > 0) return monto;
113: }
114: const matchBDV = limpio.match(/\b(\d{1,3}(?:\.\d{3})+\.\d{2})\b/);
115: if (matchBDV) {
116: const partes = matchBDV[1].split('.');
117: const decimales = partes.pop();
118: const entero = partes.join('');
119: const monto = parseFloat(entero + '.' + decimales);
120: if (!isNaN(monto) && monto > 0) return monto;
121: }
122: const patronesConEtiqueta = [
123: /(?:monto|total|importe|valor|bs\.?|bol[ií]vares?|cantidad)[^\d]{0,15}([\d]{1,3}(?:[.\s]\d{3})*(?:[.,]\d{1,2})?)/i,
124: /Bs\.?\s*([\d]{1,3}(?:[.\s]\d{3})*(?:[.,]\d{1,2})?)/i
125: ];
126: for (const patron of patronesConEtiqueta) {
127: const match = limpio.match(patron);
128: if (match) {
129: const monto = normalizarMontoVE(match[1]);
130: if (monto > 0 && monto < 999999999) return monto;
131: }
132: }
133: const matchSimple = limpio.match(/\b(\d{1,7}[.,]\d{2})\b/);
134: if (matchSimple) {
135: const monto = normalizarMontoVE(matchSimple[1]);
136: if (monto > 0) return monto;
137: }
138: return 0.00;
139: }
140: function extraerFecha(texto) {
141: if (!texto) return "";
142: let match = texto.match(/(\d{2}[\/\-.]\d{2}[\/\-.]\d{4})/);
143: if (match) return match[1].replace(/[-.]/g, '/');
144: match = texto.match(/(\d{2}):(\d{2}):(\d{4})/);
145: if (match) return `${match[1]}/${match[2]}/${match[3]}`;
146: match = texto.match(/(\d{2}[\/\-.]\d{2}[\/\-.]\d{2})\b/);
147: if (match) {
148: const partes = match[1].replace(/[-.]/g, '/').split('/');
149: return `${partes[0]}/${partes[1]}/20${partes[2]}`;
150: }
151: return "";
152: }
153: function extraerBanco(texto) {
154: if (!texto) return "Por confirmar";
155: const limpio = texto.toLowerCase();
156: const bancoPorCodigo = detectarBancoPorCodigoCuenta(texto);
157: if (bancoPorCodigo) return bancoPorCodigo;
158: const patronesBanco = [
159: /pago\s*m[oó]vil\s*(?:desde|de)?[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\s+(?:a|para|por)|\n|$)/i,
160: /transferencia\s*(?:desde|de)?[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\s+(?:a|para|por)|\n|$)/i,
161: /banco\s*(?:emisor|origen)[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\n|$)/i,
162: /origen[:\s]+([A-ZÁÉÍÓÚa-záéíóúñÑ\s]+?)(?:\n|$)/i
163: ];
164: for (const patron of patronesBanco) {
165: const match = texto.match(patron);
166: if (match && match[1]) {
167: const candidato = match[1].trim();
168: for (const [codigo, nombre] of Object.entries(CODIGOS_BANCO)) {
169: if (candidato.toLowerCase().includes(nombre.toLowerCase())) return nombre;
170: }
171: }
172: }
173: const bancos = [
174: { nombre: "Bancamiga", claves: ["bancamiga"] },
175: { nombre: "Banesco", claves: ["banesco", "banesco banco universal"] },
176: { nombre: "Mercantil", claves: ["mercantil"] },
177: { nombre: "Provincial", claves: ["provincial", "bbva"] },
178: { nombre: "Banco de Venezuela", claves: ["banco de venezuela", "bdv"] },
179: { nombre: "Bancaribe", claves: ["bancaribe"] },
180: { nombre: "Banco del Tesoro", claves: ["tesoro"] },
181: { nombre: "Banco Exterior", claves: ["exterior"] },
182: { nombre: "Banco Caroní", claves: ["caroní", "caroni"] },
183: { nombre: "Banco Plaza", claves: ["plaza"] },
184: { nombre: "Banco Activo", claves: ["activo"] },
185: { nombre: "Banco Sofitasa", claves: ["sofitasa"] },
186: { nombre: "Banplus", claves: ["banplus"] },
187: { nombre: "Mi Banco", claves: ["mi banco"] },
188: { nombre: "Banco Nacional de Crédito", claves: ["nacional de crédito", "bnc"] }
189: ];
190: for (const banco of bancos) {
191: for (const clave of banco.claves) {
192: if (limpio.includes(clave)) return banco.nombre;
193: }
194: }
195: return "Por confirmar";
196: }
197: async function preprocesarImagen(rutaOriginal) {
198: const rutaNormal = path.join(uploadDir, `ocr_normal_${Date.now()}.png`);
199: const rutaInvertida = path.join(uploadDir, `ocr_invertida_${Date.now()}.png`);
200: try {
201: await sharp(rutaOriginal)
202: .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: false })
203: .grayscale().normalize().sharpen({ sigma: 1.5 }).threshold(128)
204: .png({ compressionLevel: 6 }).toFile(rutaNormal);
205: await sharp(rutaOriginal)
206: .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: false })
207: .negate().grayscale().normalize().sharpen({ sigma: 1.5 }).threshold(128)
208: .png({ compressionLevel: 6 }).toFile(rutaInvertida);
209: return { normal: rutaNormal, invertida: rutaInvertida };
210: } catch (err) {
211: console.error("⚠️ Error en preprocesamiento:", err.message);
212: return { normal: rutaOriginal, invertida: null };
213: }
214: }
215: async function procesarImagenOCR(rutaImagen) {
216: let rutas = null;
217: try {
218: console.log("🔍 Iniciando OCR...");
219: rutas = await preprocesarImagen(rutaImagen);
220: const worker = await createWorker('spa+eng', 1);
221: await worker.setParameters({
222: tessedit_pageseg_mode: '6',
223: tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÉÍÓÚáéíóúÑñ.,:/-#Bs$%() ',
224: classify_bln_numeric_mode: '1',
225: preserve_interword_spaces: '1'
226: });
227: const { data: { text: textoNormal } } = await worker.recognize(rutas.normal);
228: let textoInvertido = "";
229: if (rutas.invertida && fs.existsSync(rutas.invertida)) {
230: const { data: { text } } = await worker.recognize(rutas.invertida);
231: textoInvertido = text;
232: }
233: await worker.terminate();
234: if (rutas.normal !== rutaImagen && fs.existsSync(rutas.normal)) {
235: try { fs.unlinkSync(rutas.normal); } catch (e) {}
236: }
237: if (rutas.invertida && fs.existsSync(rutas.invertida)) {
238: try { fs.unlinkSync(rutas.invertida); } catch (e) {}
239: }
240: return textoNormal + "\n" + textoInvertido;
241: } catch (error) {
242: console.error("❌ Error en OCR:", error);
243: if (rutas) {
244: if (rutas.normal && rutas.normal !== rutaImagen && fs.existsSync(rutas.normal)) {
245: try { fs.unlinkSync(rutas.normal); } catch (e) {}
246: }
247: if (rutas.invertida && fs.existsSync(rutas.invertida)) {
248: try { fs.unlinkSync(rutas.invertida); } catch (e) {}
249: }
250: }
251: return "";
252: }
253: }
254: async function iniciarWhatsApp(forceNew = false) {
255: if (isConnecting && !forceNew) {
256: console.log("⏳ Ya hay una conexión en proceso...");
257: return;
258: }
259: isConnecting = true;
260: estadoConexion = 'iniciando';
261: ultimoError = '';
262: console.log("🔄 Iniciando WhatsApp...");
263: try {
264: if (forceNew && fs.existsSync(authDir)) {
265: console.log("🗑️ Limpiando sesión anterior...");
266: fs.rmSync(authDir, { recursive: true, force: true });
267: }
268: if (!fs.existsSync(authDir)) {
269: fs.mkdirSync(authDir, { recursive: true });
270: }
271: let version = [2, 3000, 1037641644];
272: try {
273: const latest = await fetchLatestBaileysVersion();
274: version = latest.version;
275: console.log(`✅ Usando versión Baileys: ${version.join('.')}`);
276: } catch (e) {
277: console.log(`⚠️ Usando versión fija: ${version.join('.')}`);
278: }
279: const { state, saveCreds } = await useMultiFileAuthState(authDir);
280: sockWhatsApp = makeWASocket({
281: auth: state,
282: logger: pino({ level: 'silent' }),
283: browser: Browsers.macOS('Desktop'),
284: printQRInTerminal: false,
285: markOnlineOnConnect: true,
286: syncFullHistory: false,
287: generateHighQualityLinkPreview: false,
288: version: version
289: });
290: sockWhatsApp.ev.on('creds.update', saveCreds);
291: sockWhatsApp.ev.on('connection.update', async (update) => {
292: const { connection, lastDisconnect, qr } = update;
293: if (qr) {
294: ultimoQrGenerado = qr;
295: estadoConexion = 'esperando_qr';
296: console.log("\n📱 NUEVO QR GENERADO → Ve a /qr para escanearlo\n");
297: qrcodeTerminal.generate(qr, { small: true });
298: }
299: if (connection === 'close') {
300: isConnecting = false;
301: const statusCode = lastDisconnect?.error?.output?.statusCode;
302: const errorMsg = lastDisconnect?.error?.message || 'Sin mensaje de error';
303: console.log(`❌ Desconectado. Código: ${statusCode ?? 'undefined'}`);
304: console.log(`   Motivo: ${errorMsg}`);
305: if (statusCode === DisconnectReason.loggedOut) {
306: console.log('🔒 Sesión cerrada (loggedOut).');
307: estadoConexion = 'error';
308: ultimoError = 'Sesión cerrada desde el teléfono.';
309: ultimoQrGenerado = "";
310: return;
311: }
312: if (statusCode === DisconnectReason.badSession ||
313: statusCode === DisconnectReason.connectionClosed ||
314: statusCode === DisconnectReason.connectionLost) {
315: estadoConexion = 'reconectando';
316: intentosConexion++;
317: if (intentosConexion > MAX_INTENTOS) {
318: console.log('⚠️ Demasiados intentos.');
319: estadoConexion = 'error';
320: ultimoError = 'Demasiados intentos fallidos.';
321: return;
322: }
323: console.log(`🔄 Reintentando (${intentosConexion}/${MAX_INTENTOS}) en 5 segundos...`);
324: setTimeout(() => iniciarWhatsApp(false), 5000);
325: return;
326: }
327: estadoConexion = 'reconectando';
328: console.log('🔄 Reintentando conexión en 5 segundos...');
329: setTimeout(() => iniciarWhatsApp(false), 5000);
330: } else if (connection === 'open') {
331: isConnecting = false;
332: intentosConexion = 0;
333: estadoConexion = 'conectado';
334: console.log('\n✅ WhatsApp conectado correctamente\n');
335: ultimoQrGenerado = "";
336: }
337: });
338: sockWhatsApp.ev.on('messages.upsert', async (m) => {
339: const msg = m.messages[0];
340: if (!msg.message || msg.key.fromMe) return;
341: const remitente = msg.key.remoteJid;
342: const nombreCliente = msg.pushName || "Cliente";
343: const telefonoLimpio = remitente.split('@')[0].replace(/[^0-9]/g, '');
344: let contenido = msg.message;
345: if (contenido.ephemeralMessage) contenido = contenido.ephemeralMessage.message;
346: if (contenido.viewOnceMessage) contenido = contenido.viewOnceMessage.message;
347: if (contenido.viewOnceMessageV2) contenido = contenido.viewOnceMessageV2.message;
348: const esImagen = contenido.imageMessage;
349: const textoPlano = contenido.conversation || contenido.extendedTextMessage?.text;
350: console.log(`💬 De: ${nombreCliente} | Imagen: ${!!esImagen}`);
351: if (textoPlano && !esImagen) {
352: const ref = extraerReferencia(textoPlano);
353: const monto = extraerMonto(textoPlano);
354: const fechaComprobante = extraerFecha(textoPlano);
355: const bancoDetectado = extraerBanco(textoPlano);
356: if (!ref && monto === 0) {
357: await sockWhatsApp.sendMessage(remitente, {
358: text: `Hola ${nombreCliente} 👋\n\nEnvía una imagen del comprobante o escribe:\n_"Ref: 12345678 Monto: Bs. 150,00"_`
359: });
360: return;
361: }
362: pagosBD.unshift({
363: id: Date.now(), cliente: nombreCliente, telefono: `+${telefonoLimpio}`,
364: ref: ref || "SIN_REF", monto: monto, banco: bancoDetectado,
365: estado: "pendiente", fecha: fechaComprobante || new Date().toLocaleString(),
366: remitenteJid: remitente, imagen: null, textoOCR: textoPlano.substring(0, 600)
367: });
368: await sockWhatsApp.sendMessage(remitente, {
369: text: `✅ Comprobante recibido.\n\n📋 Datos:\n• Ref: ${ref || 'No detectada'}\n• Monto: Bs. ${monto.toFixed(2)}\n• Banco: ${bancoDetectado}\n\nPronto validaremos.`
370: });
371: return;
372: }
373: if (esImagen) {
374: try {
375: const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
376: logger: undefined, reuploadRequest: sockWhatsApp.updateMediaMessage
377: });
378: const nombreArchivo = `comprobante_${Date.now()}.jpg`;
379: const rutaCompleta = path.join(uploadDir, nombreArchivo);
380: fs.writeFileSync(rutaCompleta, buffer);
381: await sockWhatsApp.sendMessage(remitente, { text: `📸 Imagen recibida. Analizando...` });
382: const textoOCR = await procesarImagenOCR(rutaCompleta);
383: const ref = extraerReferencia(textoOCR);
384: const monto = extraerMonto(textoOCR);
385: const fechaComprobante = extraerFecha(textoOCR);
386: const bancoDetectado = extraerBanco(textoOCR);
387: console.log(`🏦 Banco: ${bancoDetectado}`);
388: pagosBD.unshift({
389: id: Date.now(), cliente: nombreCliente, telefono: `+${telefonoLimpio}`,
390: ref: ref || "SIN_REF", monto: monto, banco: bancoDetectado,
391: estado: "pendiente", fecha: fechaComprobante || new Date().toLocaleString(),
392: remitenteJid: remitente, imagen: nombreArchivo, textoOCR: textoOCR.substring(0, 600)
393: });
394: await sockWhatsApp.sendMessage(remitente, {
395: text: `✅ Imagen procesada.\n\n📋 Datos:\n• Ref: ${ref || 'No detectada'}\n• Monto: Bs. ${monto.toFixed(2)}\n• Banco: ${bancoDetectado}\n\nPronto validaremos.`
396: });
397: } catch (error) {
398: console.error("Error procesando imagen:", error);
399: await sockWhatsApp.sendMessage(remitente, { text: `❌ Error procesando la imagen. Envía los datos por texto.` });
400: }
401: }
402: });
403: } catch (err) {
404: isConnecting = false;
405: estadoConexion = 'error';
406: ultimoError = err.message;
407: console.error("❌ Error al iniciar WhatsApp:", err.message);
408: setTimeout(() => iniciarWhatsApp(false), 8000);
409: }
410: }
411: iniciarWhatsApp();
412: app.get('/api/bancos', (req, res) => res.json(LISTA_BANCOS));
413: app.get('/api/qr-status', async (req, res) => {
414: try {
415: if (!ultimoQrGenerado) {
416: return res.json({
417: status: estadoConexion,
418: qr: null,
419: message: estadoConexion === 'conectado'
420: ? '✅ WhatsApp ya está vinculado'
421: : estadoConexion === 'error'
422: ? `❌ Error: ${ultimoError}`
423: : '⏳ Esperando QR...'
424: });
425: }
426: const url = await qrcode.toDataURL(ultimoQrGenerado);
427: res.json({ status: 'esperando_qr', qr: url, message: '📱 Escanea el QR' });
428: } catch (err) {
429: res.status(500).json({ status: 'error', message: err.message });
430: }
431: });
432: app.post('/api/restart-whatsapp', (req, res) => {
433: console.log("🔄 Reinicio manual solicitado...");
434: estadoConexion = 'reconectando';
435: ultimoQrGenerado = "";
436: intentosConexion = 0;
437: iniciarWhatsApp(true);
438: res.json({ status: 'success', message: 'Reiniciando WhatsApp...' });
439: });
440: app.get('/api/status', (req, res) => {
441: res.json({
442: estado: estadoConexion,
443: conectado: sockWhatsApp !== null,
444: qrDisponible: !!ultimoQrGenerado,
445: intentos: intentosConexion,
446: ultimoError: ultimoError,
447: sesionDir: authDir,
448: sesionExiste: fs.existsSync(authDir),
449: archivosSesion: fs.existsSync(authDir) ? fs.readdirSync(authDir).length : 0,
450: uptime: process.uptime(),
451: pagos: pagosBD.length,
452: sms: smsBancoBD.length
453: });
454: });
455: app.patch('/api/pagos/:id/banco', (req, res) => {
456: const id = parseInt(req.params.id);
457: const { banco } = req.body;
458: if (!banco || typeof banco !== 'string') return res.status(400).json({ status: "error", message: "Banco inválido" });
459: const pago = pagosBD.find(p => p.id === id);
460: if (!pago) return res.status(404).json({ status: "error", message: "Pago no encontrado" });
461: pago.banco = banco;
462: pago.bancoManual = true;
463: pago.fechaEdicion = new Date().toLocaleString();
464: res.json({ status: "success", id, banco });
465: });
466: app.patch('/api/pagos/:id/estado', (req, res) => {
467: const id = parseInt(req.params.id);
468: const { estado } = req.body;
469: const pago = pagosBD.find(p => p.id === id);
470: if (!pago) return res.status(404).json({ status: "error", message: "Pago no encontrado" });
471: pago.estado = estado;
472: pago.fechaAprobacion = new Date().toLocaleString();
473: res.json({ status: "success", id, estado });
474: });
475: app.get('/qr', (req, res) => res.sendFile(path.join(__dirname, 'qr.html')));
476: app.post('/webhook/sms-banco', async (req, res) => {
477: try {
478: const { texto } = req.body;
479: smsBancoBD.unshift({ id: Date.now(), texto, fecha: new Date().toLocaleString() });
480: const ref = extraerReferencia(texto);
481: const monto = extraerMonto(texto);
482: if (!ref || monto === 0) return res.json({ status: "info", refExtraida: ref, montoExtraido: monto });
483: const pagoCoincidente = pagosBD.find(p =>
484: p.estado === "pendiente" && (p.ref === ref || p.ref === "PENDIENTE_" + ref || p.ref === "SIN_REF")
485: );
486: if (pagoCoincidente) {
487: pagoCoincidente.estado = "aprobado";
488: pagoCoincidente.monto = monto;
489: pagoCoincidente.ref = ref;
490: pagoCoincidente.fechaAprobacion = new Date().toLocaleString();
491: }
492: res.json({ status: "success", referencia: ref, monto, cruzado: !!pagoCoincidente });
493: } catch (error) {
494: res.status(500).json({ status: "error", message: error.message });
495: }
496: });
497: app.get('/api/pagos', (req, res) => res.json(pagosBD));
498: app.get('/api/sms', (req, res) => res.json(smsBancoBD));
499: app.post('/webhook/whatsapp', (req, res) => {
500: const { cliente, telefono, referencia, monto, banco, fecha } = req.body;
501: pagosBD.unshift({
502: id: Date.now(),
503: cliente: cliente || "Simulado",
504: telefono: telefono || "+584120000000",
505: ref: referencia || "9999",
506: monto: parseFloat(monto) || 0.00,
507: banco: extraerBanco(banco || "") || banco || "Por confirmar",
508: estado: "pendiente",
509: fecha: fecha || new Date().toLocaleDateString()
510: });
511: res.json({ status: "success" });
512: });
513: app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
514: const PORT = process.env.PORT || 10000;
515: app.listen(PORT, '0.0.0.0', () => {
516: console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
517: console.log(`📂 Sesión: ${authDir}`);
518: console.log(`🌐 URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}\n`);
519: });