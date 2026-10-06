/**
 * Validación de cotizaciones LFH, servidor (Google Apps Script).
 *
 * Propietario previsto: daf.adjunto@liceofranco.org
 * La página pública (GitHub Pages) envía un token de inicio de sesión Google.
 * Este script lo verifica, aplica las reglas y escribe en la hoja de registro.
 *
 * Reglas aplicadas aquí, en el servidor:
 *  - Solo cuentas @liceofranco.org verificadas y presentes en las listas de acceso.
 *  - Registran: REGISTRADORES y ADMINS.
 *  - Firman: PROTESORERA, TESORERA y PRESIDENCIA; se requieren 2 aprobaciones de las 3.
 *  - Quien registra una cotización no puede firmarla.
 *  - Una sola firma por persona y por cotización.
 *  - Huella SHA-256 de cada cotización y sello HMAC de cada firma:
 *    cualquier modificación hecha a mano en la hoja se detecta.
 *
 * Correos (activadores instalados con instalarEnvios()):
 *  - resumenSemanal(): miércoles a las 7:00, cotizaciones pendientes de firma.
 *  - resumenDiario(): cada día a las 18:00, firmas del día, solo si las hubo.
 */

const HOJA_COT = 'Cotizaciones';
const HOJA_FIR = 'Firmas';
const HOJA_LOG = 'Bitacora';
const COLS_COT = ['id', 'folio', 'proveedor', 'refProveedor', 'objeto', 'monto', 'moneda', 'departamento',
  'fechaCotizacion', 'enlace', 'archivoId', 'archivoNombre', 'archivoSha256', 'creadoPor', 'creadoPorNombre',
  'creadoEn', 'huella', 'anuladaPor', 'anuladaEn', 'motivoAnulacion'];
const COLS_FIR = ['quoteId', 'folio', 'email', 'nombre', 'rol', 'decision', 'comentario', 'en', 'huella', 'sello'];
const COLS_LOG = ['en', 'email', 'accion', 'folio', 'detalle'];
const CAMPOS_HUELLA = ['folio', 'proveedor', 'refProveedor', 'objeto', 'monto', 'moneda', 'departamento',
  'fechaCotizacion', 'enlace', 'archivoSha256', 'creadoPor', 'creadoEn'];
const REQUERIDAS = 2;
const MAX_ARCHIVO = 10 * 1024 * 1024;
const MONEDAS = ['HNL', 'USD', 'EUR'];
const TIPOS = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
const ZONA = 'America/Tegucigalpa';
const ROLES = [['PROTESORERA', 'Protesorera'], ['TESORERA', 'Tesorera'], ['PRESIDENCIA', 'Presidencia']];
const HORA_SEMANAL = 7;   // miércoles
const HORA_DIARIO = 18;   // todos los días

/* =====================================================================
 * Instalación: ejecutar setup() una vez desde el editor.
 * ===================================================================== */
function setup() {
  const p = PropertiesService.getScriptProperties();
  let ss;
  if (p.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  } else {
    ss = SpreadsheetApp.create('Validación de cotizaciones LFH (registro)');
    p.setProperty('SHEET_ID', ss.getId());
  }
  prepararHoja_(ss, HOJA_COT, COLS_COT);
  prepararHoja_(ss, HOJA_FIR, COLS_FIR);
  prepararHoja_(ss, HOJA_LOG, COLS_LOG);
  ss.getSheets().forEach(function (sh) {
    if ([HOJA_COT, HOJA_FIR, HOJA_LOG].indexOf(sh.getName()) < 0 && ss.getSheets().length > 3) ss.deleteSheet(sh);
  });
  if (!p.getProperty('FOLDER_ID')) {
    p.setProperty('FOLDER_ID', DriveApp.createFolder('Cotizaciones LFH (documentos)').getId());
  }
  if (!p.getProperty('SECRETO')) p.setProperty('SECRETO', Utilities.getUuid() + Utilities.getUuid());
  p.setProperty('PROPIETARIO', Session.getEffectiveUser().getEmail().toLowerCase());
  const defecto = {
    DOMINIO: 'liceofranco.org',
    CLIENT_ID: 'PENDIENTE',
    PROTESORERA: 'PENDIENTE',
    TESORERA: 'PENDIENTE',
    PRESIDENCIA: 'PENDIENTE',
    REGISTRADORES: 'daf.adjunto@liceofranco.org, karen.barrientos@liceofranco.org',
    ADMINS: '',
    NOTIFICAR: 'si',
    URL_PAGINA: 'https://dafadjunto-504.github.io/validacion-cotizaciones/'
  };
  Object.keys(defecto).forEach(function (k) {
    if (p.getProperty(k) === null) p.setProperty(k, defecto[k]);
  });
  Logger.log('Hoja de registro: ' + ss.getUrl());
  Logger.log('Carpeta de documentos: ' + DriveApp.getFolderById(p.getProperty('FOLDER_ID')).getUrl());
  Logger.log('Complete ahora CLIENT_ID, PROTESORERA, TESORERA y PRESIDENCIA en Configuración del proyecto > Propiedades del script. Después ejecute instalarEnvios().');
}

/** Crea (o recrea) los dos envíos programados: semanal y diario. */
function instalarEnvios() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['resumenSemanal', 'resumenDiario'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('resumenSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(HORA_SEMANAL).nearMinute(0).create();
  ScriptApp.newTrigger('resumenDiario').timeBased().everyDays(1).atHour(HORA_DIARIO).nearMinute(0).create();
  const p = PropertiesService.getScriptProperties();
  const ahora = new Date().toISOString();
  if (!p.getProperty('ULTIMO_SEMANAL')) p.setProperty('ULTIMO_SEMANAL', ahora);
  if (!p.getProperty('ULTIMO_DIARIO')) p.setProperty('ULTIMO_DIARIO', ahora);
  Logger.log('Envíos programados: miércoles hacia las ' + HORA_SEMANAL + ':00 y cada día hacia las ' + HORA_DIARIO + ':00 (hora de ' + ZONA + ').');
}

/** Muestra en el registro de ejecución el estado de la configuración. */
function probarConfiguracion() {
  const c = cfg_();
  const lineas = [
    'Propietario: ' + c.propietario,
    'Dominio: ' + c.dominio,
    'CLIENT_ID: ' + (c.clientId ? 'definido' : 'FALTA'),
    'Validadoras: ' + c.roles.map(function (r) { return r.rol + ' = ' + (r.email || 'FALTA'); }).join(' | '),
    'Envíos programados: ' + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(', '),
    'Registradores (' + c.registradores.length + '): ' + c.registradores.join(', '),
    'Administradores: ' + c.admins.join(', '),
    'Hoja: ' + (c.sheetId ? SpreadsheetApp.openById(c.sheetId).getUrl() : 'FALTA, ejecute setup()'),
    'Carpeta: ' + (c.folderId ? DriveApp.getFolderById(c.folderId).getUrl() : 'FALTA, ejecute setup()')
  ];
  if (c.validadores.length < REQUERIDAS) lineas.push('ATENCION: se necesitan al menos ' + REQUERIDAS + ' validadoras con correo.');
  const cruce = c.validadores.filter(function (v) { return c.registradores.indexOf(v) >= 0; });
  if (cruce.length) lineas.push('ATENCION: estas cuentas registran y validan a la vez: ' + cruce.join(', '));
  Logger.log(lineas.join('\n'));
}

function prepararHoja_(ss, nombre, cols) {
  const sh = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
  sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const yaProtegida = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0;
  if (!yaProtegida) {
    const prot = sh.protect().setDescription('Escrito solo por el script de validación');
    prot.removeEditors(prot.getEditors());
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
  }
  return sh;
}

/* =====================================================================
 * Configuración
 * ===================================================================== */
function cfg_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const lista = function (s) {
    return String(s || '').split(/[,;\s]+/).map(function (x) { return x.trim().toLowerCase(); })
      .filter(function (x) { return x && x !== 'pendiente'; });
  };
  const propietario = String(p.PROPIETARIO || '').toLowerCase();
  const admins = lista(p.ADMINS);
  if (propietario && admins.indexOf(propietario) < 0) admins.push(propietario);
  const roles = ROLES.map(function (r) { return { clave: r[0], rol: r[1], email: lista(p[r[0]])[0] || '' }; });
  const rolDe = {};
  roles.forEach(function (r) { if (r.email) rolDe[r.email] = r.rol; });
  return {
    clientId: p.CLIENT_ID && p.CLIENT_ID !== 'PENDIENTE' ? p.CLIENT_ID.trim() : '',
    dominio: String(p.DOMINIO || 'liceofranco.org').trim().toLowerCase(),
    roles: roles,
    rolDe: rolDe,
    validadores: Object.keys(rolDe),
    registradores: lista(p.REGISTRADORES),
    admins: admins,
    propietario: propietario,
    sheetId: p.SHEET_ID,
    folderId: p.FOLDER_ID,
    secreto: p.SECRETO,
    notificar: String(p.NOTIFICAR || 'si').trim().toLowerCase() !== 'no',
    urlPagina: p.URL_PAGINA || ''
  };
}

/* =====================================================================
 * Entrada HTTP
 * ===================================================================== */
function doGet() {
  return json_({ ok: true, servicio: 'validacion-cotizaciones-lfh' });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const c = cfg_();
    if (!c.sheetId || !c.secreto) throw err_('config', 'El servidor no está instalado: ejecute setup().');
    const u = verificarToken_(req.token, c);
    u.puedeRegistrar = c.registradores.indexOf(u.email) >= 0 || c.admins.indexOf(u.email) >= 0;
    u.puedeValidar = c.validadores.indexOf(u.email) >= 0;
    u.rol = c.rolDe[u.email] || '';
    u.esAdmin = c.admins.indexOf(u.email) >= 0;
    u.acceso = u.puedeRegistrar || u.puedeValidar || u.esAdmin;
    const acciones = {
      whoami: accWhoami_,
      listar: accListar_,
      registrar: accRegistrar_,
      firmar: accFirmar_,
      anular: accAnular_,
      archivo: accArchivo_
    };
    const fn = acciones[req.action];
    if (!fn) throw err_('bad', 'Acción desconocida.');
    if (req.action !== 'whoami' && !u.acceso) throw err_('forbidden', 'Su cuenta no tiene acceso a este registro.');
    out = { ok: true, data: fn(u, req.payload || {}, c) };
  } catch (x) {
    out = x && x.code
      ? { ok: false, code: x.code, message: x.message }
      : { ok: false, code: 'error', message: 'Error del servidor: ' + (x && x.message ? x.message : x) };
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function err_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* =====================================================================
 * Identidad: verificación del token Google (ID token)
 * ===================================================================== */
function verificarToken_(token, c) {
  if (!token || typeof token !== 'string') throw err_('auth', 'Inicie sesión con su cuenta del LFH.');
  if (!c.clientId) throw err_('config', 'Falta CLIENT_ID en las propiedades del script.');
  const cache = CacheService.getScriptCache();
  const clave = 'tk_' + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8)).slice(0, 48);
  const enCache = cache.get(clave);
  let info;
  if (enCache) {
    info = JSON.parse(enCache);
  } else {
    const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw err_('auth', 'Su sesión no es válida o venció. Vuelva a iniciar sesión.');
    info = JSON.parse(r.getContentText());
  }
  const ahora = Math.floor(Date.now() / 1000);
  if (info.aud !== c.clientId) throw err_('auth', 'Sesión emitida para otra aplicación.');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(info.iss) < 0) throw err_('auth', 'Emisor de sesión no reconocido.');
  if (String(info.email_verified) !== 'true') throw err_('auth', 'Correo de la cuenta no verificado.');
  if (Number(info.exp) <= ahora) throw err_('auth', 'Su sesión venció. Vuelva a iniciar sesión.');
  const email = String(info.email || '').toLowerCase();
  if (String(info.hd || '').toLowerCase() !== c.dominio || email.slice(-(c.dominio.length + 1)) !== '@' + c.dominio) {
    throw err_('auth', 'Solo las cuentas @' + c.dominio + ' pueden usar este registro.');
  }
  if (!enCache) cache.put(clave, JSON.stringify(info), Math.max(1, Math.min(600, Number(info.exp) - ahora)));
  return { email: email, nombre: String(info.name || email) };
}

/* =====================================================================
 * Acceso a la hoja
 * ===================================================================== */
function libro_(c) { return SpreadsheetApp.openById(c.sheetId); }

function filas_(sh, cols) {
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols.length).getDisplayValues().map(function (r, i) {
    const o = { _fila: i + 2 };
    cols.forEach(function (k, j) { o[k] = r[j]; });
    return o;
  });
}

function celda_(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function agregar_(sh, cols, obj) {
  const fila = sh.getLastRow() + 1;
  const rg = sh.getRange(fila, 1, 1, cols.length);
  rg.setNumberFormat('@');
  rg.setValues([cols.map(function (k) { return celda_(obj[k]); })]);
  return fila;
}

function bitacora_(ss, email, accion, folio, detalle) {
  agregar_(ss.getSheetByName(HOJA_LOG), COLS_LOG,
    { en: new Date().toISOString(), email: email, accion: accion, folio: folio || '', detalle: detalle || '' });
}

/* =====================================================================
 * Huella y sello
 * ===================================================================== */
function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function huella_(q) {
  const base = JSON.stringify(CAMPOS_HUELLA.map(function (k) { return q[k] === null || q[k] === undefined ? '' : String(q[k]); }));
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, base, Utilities.Charset.UTF_8));
}

function sello_(f, secreto) {
  const base = [f.quoteId, f.folio, f.email, f.nombre, f.rol || '', f.decision, f.comentario, f.en, f.huella].join('|');
  return hex_(Utilities.computeHmacSha256Signature(base, secreto, Utilities.Charset.UTF_8));
}

/* =====================================================================
 * Estado de una cotización
 * ===================================================================== */
function evaluar_(q, firmas, c) {
  const integra = huella_(q) === q.huella;
  const lista = firmas.filter(function (f) { return f.quoteId === q.id; })
    .sort(function (a, b) { return a.en < b.en ? -1 : a.en > b.en ? 1 : 0; })
    .map(function (f) {
      let motivo = '';
      if (sello_(f, c.secreto) !== f.sello) motivo = 'El registro de esta firma fue modificado fuera del sistema.';
      else if (!integra || f.huella !== q.huella) motivo = 'La cotización cambió después de esta firma.';
      else if (f.email === q.creadoPor) motivo = 'Quien registró la cotización no puede firmarla.';
      return {
        email: f.email, nombre: f.nombre, rol: f.rol || (c.rolDe && c.rolDe[f.email]) || '', decision: f.decision,
        comentario: f.comentario, en: f.en, valida: !motivo, motivo: motivo, sello: f.sello
      };
    });
  const validas = lista.filter(function (f) { return f.valida; });
  const aprob = {};
  validas.forEach(function (f) { if (f.decision === 'aprobada') aprob[f.email] = true; });
  const nAprob = Object.keys(aprob).length;
  const rechazo = validas.some(function (f) { return f.decision === 'rechazada'; });
  let estado;
  if (q.anuladaEn) estado = 'anulada';
  else if (!integra) estado = 'alterada';
  else if (rechazo) estado = 'rechazada';
  else if (nAprob >= REQUERIDAS) estado = 'validada';
  else if (nAprob > 0) estado = 'parcial';
  else estado = 'pendiente';
  return { estado: estado, integra: integra, firmas: lista, aprobaciones: nAprob };
}

function publica_(q, ev) {
  return {
    id: q.id, folio: q.folio, proveedor: q.proveedor, refProveedor: q.refProveedor, objeto: q.objeto,
    monto: q.monto, moneda: q.moneda, departamento: q.departamento, fechaCotizacion: q.fechaCotizacion,
    enlace: q.enlace, tieneArchivo: !!q.archivoId, archivoNombre: q.archivoNombre, archivoSha256: q.archivoSha256,
    creadoPor: q.creadoPor, creadoPorNombre: q.creadoPorNombre, creadoEn: q.creadoEn, huella: q.huella,
    anulada: q.anuladaEn ? { por: q.anuladaPor, en: q.anuladaEn, motivo: q.motivoAnulacion } : null,
    estado: ev.estado, integra: ev.integra, aprobaciones: ev.aprobaciones, firmas: ev.firmas
  };
}

function buscar_(ss, id) {
  const q = filas_(ss.getSheetByName(HOJA_COT), COLS_COT).filter(function (r) { return r.id === id; })[0];
  if (!q) throw err_('not_found', 'La cotización no existe.');
  return q;
}

/* =====================================================================
 * Acciones
 * ===================================================================== */
function accWhoami_(u, p, c) {
  return {
    email: u.email, nombre: u.nombre, acceso: u.acceso, puedeRegistrar: u.puedeRegistrar,
    puedeValidar: u.puedeValidar, esAdmin: u.esAdmin, rol: u.rol, requeridas: REQUERIDAS
  };
}

function accListar_(u, p, c) {
  const ss = libro_(c);
  const firmas = filas_(ss.getSheetByName(HOJA_FIR), COLS_FIR);
  const cot = filas_(ss.getSheetByName(HOJA_COT), COLS_COT)
    .map(function (q) { return publica_(q, evaluar_(q, firmas, c)); })
    .sort(function (a, b) { return a.creadoEn < b.creadoEn ? 1 : a.creadoEn > b.creadoEn ? -1 : 0; });
  return {
    cotizaciones: cot,
    roles: c.roles.map(function (r) { return { rol: r.rol, email: r.email }; }),
    requeridas: REQUERIDAS,
    servidor: new Date().toISOString()
  };
}

function accRegistrar_(u, p, c) {
  if (!u.puedeRegistrar) throw err_('forbidden', 'Su cuenta no está autorizada para registrar cotizaciones.');
  const txt = function (v, max) { return String(v === null || v === undefined ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max); };
  const q = {
    proveedor: txt(p.proveedor, 160),
    refProveedor: txt(p.refProveedor, 80),
    objeto: txt(p.objeto, 2000),
    moneda: txt(p.moneda, 3).toUpperCase(),
    departamento: txt(p.departamento, 120),
    fechaCotizacion: txt(p.fechaCotizacion, 10),
    enlace: txt(p.enlace, 500)
  };
  if (!q.proveedor) throw err_('bad', 'Indique el proveedor.');
  if (!q.objeto) throw err_('bad', 'Describa el objeto de la cotización.');
  const monto = Number(p.monto);
  if (!isFinite(monto) || monto < 0) throw err_('bad', 'Indique un monto válido.');
  q.monto = monto.toFixed(2);
  if (MONEDAS.indexOf(q.moneda) < 0) throw err_('bad', 'Moneda no admitida.');
  if (q.fechaCotizacion && !/^\d{4}-\d{2}-\d{2}$/.test(q.fechaCotizacion)) throw err_('bad', 'Fecha de cotización no válida.');
  if (q.enlace && !/^https:\/\/\S+$/i.test(q.enlace)) throw err_('bad', 'El enlace debe empezar por https://');

  // Archivo adjunto (opcional), guardado en la carpeta Drive de la cuenta propietaria
  let archivo = null;
  if (p.archivo && p.archivo.base64) {
    const mime = String(p.archivo.tipo || '');
    if (!TIPOS[mime]) throw err_('bad', 'Formato no admitido. Use PDF, PNG o JPG.');
    const bytes = Utilities.base64Decode(String(p.archivo.base64));
    if (!bytes.length) throw err_('bad', 'El archivo está vacío.');
    if (bytes.length > MAX_ARCHIVO) throw err_('bad', 'El archivo supera 10 MB.');
    const nombre = txt(p.archivo.nombre, 150).replace(/[\\\/:*?"<>|]/g, '_') || ('cotizacion.' + TIPOS[mime]);
    const sha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
    const f = DriveApp.getFolderById(c.folderId).createFile(Utilities.newBlob(bytes, mime, nombre));
    archivo = { id: f.getId(), nombre: nombre, sha: sha, file: f };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let ss;
  try {
    ss = libro_(c);
    const sh = ss.getSheetByName(HOJA_COT);
    const ahora = new Date();
    const anio = Utilities.formatDate(ahora, ZONA, 'yyyy');
    const prefijo = 'COT-' + anio + '-';
    let max = 0;
    filas_(sh, COLS_COT).forEach(function (r) {
      if (r.folio.indexOf(prefijo) === 0) max = Math.max(max, parseInt(r.folio.slice(prefijo.length), 10) || 0);
    });
    q.id = Utilities.getUuid();
    q.folio = prefijo + ('000' + (max + 1)).slice(-4);
    q.archivoId = archivo ? archivo.id : '';
    q.archivoNombre = archivo ? archivo.nombre : '';
    q.archivoSha256 = archivo ? archivo.sha : '';
    q.creadoPor = u.email;
    q.creadoPorNombre = u.nombre;
    q.creadoEn = ahora.toISOString();
    q.huella = huella_(q);
    agregar_(sh, COLS_COT, q);
    bitacora_(ss, u.email, 'registrar', q.folio, q.proveedor + ' ' + q.moneda + ' ' + q.monto);
  } finally {
    lock.releaseLock();
  }
  if (archivo) archivo.file.setName(q.folio + ' - ' + archivo.nombre);
  // Sin correo inmediato: la cotización entra en el resumen semanal del miércoles.
  return { id: q.id, folio: q.folio };
}

function accFirmar_(u, p, c) {
  if (!u.puedeValidar) throw err_('forbidden', 'Su cuenta no figura en la lista de validadores.');
  const decision = String(p.decision || '');
  if (decision !== 'aprobada' && decision !== 'rechazada') throw err_('bad', 'Decisión no válida.');
  const comentario = String(p.comentario || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  if (decision === 'rechazada' && !comentario) throw err_('bad', 'Indique el motivo del rechazo.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let q, ev, ss;
  try {
    ss = libro_(c);
    q = buscar_(ss, String(p.id || ''));
    const shF = ss.getSheetByName(HOJA_FIR);
    const firmas = filas_(shF, COLS_FIR);
    ev = evaluar_(q, firmas, c);
    if (ev.estado === 'anulada') throw err_('closed', 'La cotización está anulada.');
    if (!ev.integra) throw err_('closed', 'La cotización fue modificada fuera del sistema y no puede firmarse.');
    if (ev.estado !== 'pendiente' && ev.estado !== 'parcial') throw err_('closed', 'La cotización ya está cerrada.');
    if (q.creadoPor === u.email) throw err_('forbidden', 'Quien registró la cotización no puede firmarla.');
    if (firmas.some(function (f) { return f.quoteId === q.id && f.email === u.email; })) throw err_('closed', 'Usted ya firmó esta cotización.');
    if (p.huella !== q.huella) throw err_('stale', 'La cotización que revisó no es la versión vigente. Recargue la página.');
    const f = {
      quoteId: q.id, folio: q.folio, email: u.email, nombre: u.nombre, rol: u.rol, decision: decision,
      comentario: comentario, en: new Date().toISOString(), huella: q.huella
    };
    f.sello = sello_(f, c.secreto);
    agregar_(shF, COLS_FIR, f);
    bitacora_(ss, u.email, 'firmar', q.folio, decision);
    firmas.push(f);
    ev = evaluar_(q, firmas, c);
  } finally {
    lock.releaseLock();
  }
  // Sin correo inmediato: la firma entra en el resumen diario de las 18:00.
  return { estado: ev.estado };
}

function accAnular_(u, p, c) {
  const motivo = String(p.motivo || '').trim().slice(0, 500);
  if (!motivo) throw err_('bad', 'Indique el motivo de la anulación.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = libro_(c);
    const q = buscar_(ss, String(p.id || ''));
    if (q.creadoPor !== u.email && !u.esAdmin) throw err_('forbidden', 'Solo quien registró la cotización o un administrador puede anularla.');
    const ev = evaluar_(q, filas_(ss.getSheetByName(HOJA_FIR), COLS_FIR), c);
    if (ev.estado === 'anulada') throw err_('closed', 'La cotización ya está anulada.');
    if (ev.estado === 'validada') throw err_('closed', 'Una cotización validada no puede anularse.');
    const col = COLS_COT.indexOf('anuladaPor') + 1;
    const rg = ss.getSheetByName(HOJA_COT).getRange(q._fila, col, 1, 3);
    rg.setNumberFormat('@');
    rg.setValues([[u.email, new Date().toISOString(), celda_(motivo)]]);
    bitacora_(ss, u.email, 'anular', q.folio, motivo);
  } finally {
    lock.releaseLock();
  }
  return { estado: 'anulada' };
}

function accArchivo_(u, p, c) {
  const ss = libro_(c);
  const q = buscar_(ss, String(p.id || ''));
  if (!q.archivoId) throw err_('not_found', 'Esta cotización no tiene archivo adjunto.');
  const blob = DriveApp.getFileById(q.archivoId).getBlob();
  const bytes = blob.getBytes();
  return {
    nombre: q.archivoNombre,
    tipo: blob.getContentType(),
    base64: Utilities.base64Encode(bytes),
    shaRegistrado: q.archivoSha256,
    shaActual: hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes))
  };
}

/* =====================================================================
 * Correos programados
 * ===================================================================== */

/**
 * Miércoles 7:00. Envía a las validadoras (con copia a quienes registran)
 * la lista de cotizaciones pendientes de firma. Sin pendientes, no envía nada.
 */
function resumenSemanal() {
  const c = cfg_();
  const p = PropertiesService.getScriptProperties();
  const ahora = new Date();
  const desde = p.getProperty('ULTIMO_SEMANAL') || new Date(ahora.getTime() - 7 * 864e5).toISOString();
  const ss = libro_(c);
  const firmas = filas_(ss.getSheetByName(HOJA_FIR), COLS_FIR);
  const pendientes = filas_(ss.getSheetByName(HOJA_COT), COLS_COT)
    .map(function (q) { return { q: q, ev: evaluar_(q, firmas, c) }; })
    .filter(function (x) { return x.ev.estado === 'pendiente' || x.ev.estado === 'parcial'; })
    .sort(function (a, b) { return a.q.creadoEn < b.q.creadoEn ? -1 : 1; });

  if (pendientes.length) {
    const nuevas = pendientes.filter(function (x) { return x.q.creadoEn > desde; }).length;
    const filasHtml = pendientes.map(function (x) {
      const q = x.q;
      return '<tr>' +
        td_(esc_(q.folio) + (q.creadoEn > desde ? '<br><b style="color:#1d5c6e">Nueva</b>' : '')) +
        td_(esc_(q.proveedor)) + td_(esc_(q.objeto)) +
        td_(esc_(monto_(q.monto, q.moneda)), 'right') +
        td_(esc_(fecha_(q.creadoEn)) + '<br>' + esc_(q.creadoPorNombre || q.creadoPor)) +
        td_(estadoFirmas_(x.ev, c)) + '</tr>';
    }).join('');
    const html = cabecera_('Cotizaciones por firmar') +
      '<p>Hay <b>' + pendientes.length + '</b> cotización(es) pendiente(s) de firma' +
      (nuevas ? ', de las cuales ' + nuevas + ' registrada(s) desde el último resumen' : '') + '.' +
      ' Cada una requiere ' + REQUERIDAS + ' firmas entre protesorera, tesorera y presidencia.</p>' +
      tabla_(['Folio', 'Proveedor', 'Objeto', 'Monto', 'Registrada', 'Firmas'], filasHtml) +
      boton_(c) + pie_();
    const texto = 'Cotizaciones pendientes de firma: ' + pendientes.length + '\n\n' +
      pendientes.map(function (x) {
        return x.q.folio + ' | ' + x.q.proveedor + ' | ' + monto_(x.q.monto, x.q.moneda) + ' | ' + estadoTexto_(x.ev, c);
      }).join('\n') + '\n\nFirmar en: ' + c.urlPagina;
    enviar_(c, c.validadores, c.registradores,
      'Cotizaciones por firmar: ' + pendientes.length + ' (' + Utilities.formatDate(ahora, ZONA, 'dd/MM/yyyy') + ')',
      html, texto);
    bitacora_(ss, 'sistema', 'resumen-semanal', '', pendientes.length + ' pendientes');
  } else {
    Logger.log('Resumen semanal: no hay cotizaciones pendientes, no se envía correo.');
  }
  p.setProperty('ULTIMO_SEMANAL', ahora.toISOString());
}

/**
 * Cada día a las 18:00. Envía a las validadoras y a quienes registran las firmas
 * registradas desde el último resumen diario. Sin firmas, no envía nada.
 */
function resumenDiario() {
  const c = cfg_();
  const p = PropertiesService.getScriptProperties();
  const ahora = new Date();
  const desde = p.getProperty('ULTIMO_DIARIO') || new Date(ahora.getTime() - 864e5).toISOString();
  const hasta = ahora.toISOString();
  const ss = libro_(c);
  const firmas = filas_(ss.getSheetByName(HOJA_FIR), COLS_FIR);
  const delDia = firmas.filter(function (f) { return f.en > desde && f.en <= hasta; });

  if (delDia.length) {
    const cot = {};
    filas_(ss.getSheetByName(HOJA_COT), COLS_COT).forEach(function (q) { cot[q.id] = q; });
    const ids = [];
    delDia.forEach(function (f) { if (ids.indexOf(f.quoteId) < 0 && cot[f.quoteId]) ids.push(f.quoteId); });
    const grupos = ids.map(function (id) {
      const q = cot[id];
      const ev = evaluar_(q, firmas, c);
      return { q: q, ev: ev, hoy: ev.firmas.filter(function (f) { return f.en > desde && f.en <= hasta; }) };
    });
    const nVal = grupos.filter(function (g) { return g.ev.estado === 'validada'; }).length;
    const nRech = grupos.filter(function (g) { return g.ev.estado === 'rechazada'; }).length;

    const bloques = grupos.map(function (g) {
      const q = g.q;
      const color = g.ev.estado === 'validada' ? '#1d7548' : g.ev.estado === 'rechazada' ? '#ae332c' : '#1d5c6e';
      const firmasHtml = g.hoy.map(function (f) {
        return '<li>' + esc_((f.rol ? f.rol + ': ' : '') + (f.nombre || f.email)) + ', ' +
          (f.decision === 'aprobada' ? 'aprobó' : '<b style="color:#ae332c">rechazó</b>') + ' a las ' +
          esc_(Utilities.formatDate(new Date(f.en), ZONA, 'HH:mm')) +
          (f.comentario ? '<br><i>' + esc_(f.comentario) + '</i>' : '') +
          (f.valida ? '' : '<br><span style="color:#8f6200">' + esc_(f.motivo) + '</span>') + '</li>';
      }).join('');
      return '<div style="border:1px solid #d3dcdf;border-left:4px solid ' + color + ';padding:10px 14px;margin:10px 0">' +
        '<div style="font-family:monospace;color:#5a6b72">' + esc_(q.folio) + '</div>' +
        '<div><b>' + esc_(q.proveedor) + '</b>, ' + esc_(monto_(q.monto, q.moneda)) + '</div>' +
        '<div style="color:#5a6b72">' + esc_(q.objeto) + '</div>' +
        '<ul style="margin:8px 0;padding-left:18px">' + firmasHtml + '</ul>' +
        '<div>Estado: <b style="color:' + color + '">' + esc_(estadoTexto_(g.ev, c)) + '</b></div></div>';
    }).join('');

    const fechaHoy = Utilities.formatDate(ahora, ZONA, 'dd/MM/yyyy');
    const html = cabecera_('Firmas del ' + fechaHoy) +
      '<p><b>' + delDia.length + '</b> firma(s) registrada(s) hoy sobre ' + grupos.length + ' cotización(es). ' +
      'Validadas: <b>' + nVal + '</b>. Rechazadas: <b>' + nRech + '</b>.</p>' +
      bloques + boton_(c) + pie_();
    const texto = 'Firmas del ' + fechaHoy + '\n\n' + grupos.map(function (g) {
      return g.q.folio + ' | ' + g.q.proveedor + ' | ' + monto_(g.q.monto, g.q.moneda) + ' | ' + estadoTexto_(g.ev, c) + '\n' +
        g.hoy.map(function (f) { return '  - ' + (f.rol || f.email) + ': ' + f.decision + (f.comentario ? ' (' + f.comentario + ')' : ''); }).join('\n');
    }).join('\n\n') + '\n\nRegistro: ' + c.urlPagina;
    enviar_(c, c.validadores.concat(c.registradores), [],
      'Firmas del ' + fechaHoy + ': ' + nVal + ' validada(s), ' + nRech + ' rechazada(s)', html, texto);
    bitacora_(ss, 'sistema', 'resumen-diario', '', delDia.length + ' firmas');
  } else {
    Logger.log('Resumen diario: ninguna firma desde ' + desde + ', no se envía correo.');
  }
  p.setProperty('ULTIMO_DIARIO', hasta);
}

/* ---------- piezas de los correos ---------- */
function estadoTexto_(ev, c) {
  if (ev.estado === 'validada') return 'Validada';
  if (ev.estado === 'rechazada') return 'Rechazada';
  if (ev.estado === 'anulada') return 'Anulada';
  if (ev.estado === 'alterada') return 'Modificada fuera del sistema';
  return ev.aprobaciones + ' de ' + REQUERIDAS + ' firmas';
}

function estadoFirmas_(ev, c) {
  const validas = ev.firmas.filter(function (f) { return f.valida; });
  const hechas = validas.map(function (f) { return esc_(f.rol || f.nombre) + ': ' + (f.decision === 'aprobada' ? 'aprobada' : 'rechazada'); });
  const firmaron = validas.map(function (f) { return f.email; });
  const faltan = c.roles.filter(function (r) { return r.email && firmaron.indexOf(r.email) < 0; })
    .map(function (r) { return esc_(r.rol); });
  return (hechas.length ? hechas.join('<br>') + '<br>' : '') +
    '<span style="color:#8f6200">Falta(n) ' + (REQUERIDAS - ev.aprobaciones) + ' de: ' + faltan.join(', ') + '</span>';
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}
function monto_(m, cur) {
  const n = Number(m);
  if (!isFinite(n)) return cur + ' ' + m;
  return cur + ' ' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fecha_(iso) { return iso ? Utilities.formatDate(new Date(iso), ZONA, 'dd/MM/yyyy') : ''; }
function td_(html, align) {
  return '<td style="border:1px solid #d3dcdf;padding:6px 8px;vertical-align:top' + (align ? ';text-align:' + align : '') + '">' + html + '</td>';
}
function tabla_(titulos, filas) {
  return '<table style="border-collapse:collapse;width:100%;font-size:14px"><tr>' +
    titulos.map(function (t) { return '<th style="border:1px solid #d3dcdf;padding:6px 8px;background:#eef3f4;text-align:left">' + t + '</th>'; }).join('') +
    '</tr>' + filas + '</table>';
}
function cabecera_(titulo) {
  return '<div style="font-family:Arial,sans-serif;color:#16252c;max-width:760px">' +
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5a6b72">Liceo Franco Hondureño · Administración y Finanzas</div>' +
    '<h2 style="margin:4px 0 12px;font-size:20px">' + esc_(titulo) + '</h2>';
}
function boton_(c) {
  return c.urlPagina
    ? '<p style="margin:18px 0"><a href="' + esc_(c.urlPagina) + '" style="background:#1d5c6e;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Abrir el registro de cotizaciones</a></p>'
    : '';
}
function pie_() {
  return '<p style="font-size:12px;color:#5a6b72">Mensaje automático del sistema de validación de cotizaciones del LFH.</p></div>';
}

function enviar_(c, para, copia, asunto, html, texto) {
  if (!c.notificar) { Logger.log('NOTIFICAR=no: correo no enviado (' + asunto + ')'); return; }
  const unicos = function (l) {
    const v = {};
    return l.filter(function (d) { if (!d || v[d]) return false; v[d] = true; return true; });
  };
  const to = unicos(para);
  const cc = unicos(copia).filter(function (d) { return to.indexOf(d) < 0; });
  if (!to.length) { Logger.log('Sin destinatarios: ' + asunto); return; }
  MailApp.sendEmail({
    to: to.join(','), cc: cc.join(','), subject: '[LFH] ' + asunto,
    htmlBody: html, body: texto, name: 'Validación de cotizaciones LFH'
  });
  Logger.log('Correo enviado a ' + to.join(', ') + (cc.length ? ' (copia: ' + cc.join(', ') + ')' : '') + ': ' + asunto);
}
