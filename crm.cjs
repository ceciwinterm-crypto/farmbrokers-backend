// crm.cjs — CRM Farm Brokers v2: campos, clientes, match, tasaciones, seguimiento y actividad
// Conexión en server.js (una línea):
//   CommonJS:  app.use('/api/crm', require('./crm.cjs'));
//   ESM:       import crm from './crm.cjs';   y   app.use('/api/crm', crm);
// Variable requerida en Railway: CRM_KEY (clave del equipo)

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
router.use(express.json({ limit: '15mb' }));

const DIR = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), 'crm');
const FILE = path.join(DIR, 'crm.json');
const VERSION = 'crm-v4.0';
const zlib = require('zlib');
const https = require('https');
const ARCHIVOS = path.join(DIR, 'archivos');

// ───────────────────────── Catálogos ─────────────────────────
const ETAPAS = {
  campos: ['Prospección', 'Captación', 'Documentación', 'Mandato firmado', 'Publicado', 'En negociación', 'Vendido', 'Arrendado', 'Suspendido', 'Retirado de la web', 'Descartado'],
  tasaciones: ['Solicitud', 'Cotizada', 'Aceptada', 'En terreno', 'Informe entregado', 'Pagada', 'Perdida'],
  clientes: ['Activo', 'Pausado', 'Compró', 'Descartado'],
};
const CAMPO_ACTIVAS = ['Captación', 'Documentación', 'Mandato firmado', 'Publicado', 'En negociación'];
const CAMPO_OFRECIBLES = ['Mandato firmado', 'Publicado', 'En negociación'];
const CHECKLIST = [
  ['mandato', 'Mandato firmado'], ['dominio', 'Dominio vigente'], ['hipotecas', 'Certificado de hipotecas y gravámenes'],
  ['avaluo', 'Certificado de avalúo fiscal'], ['aguas', 'Inscripción derechos de agua'], ['plano', 'Plano o KMZ'],
  ['fotos', 'Fotos'], ['publicacion', 'Publicado en web'],
];
const TIPOS_BASE = { agricola: 'Agrícola', loteo: 'Loteo', forestal: 'Forestal', conservacion: 'Conservación', urbano: 'Urbano',
  agroindustrial: 'Agroindustrial', derechos_agua: 'Derechos de agua', energia: 'Energía' };
let tiposExtra = {}; // tipos agregados por el equipo (se cargan desde el archivo del CRM)
const todosLosTipos = () => ({ ...TIPOS_BASE, ...tiposExtra });
const TIPOS = { includes: (k) => Object.prototype.hasOwnProperty.call(todosLosTipos(), k) };
const REGIONES = ['XV', 'I', 'II', 'III', 'IV', 'V', 'RM', 'VI', 'VII', 'XVI', 'VIII', 'IX', 'XIV', 'X', 'XI', 'XII'];
const CULTIVOS = {
  paltos: /\bpalt(o|os|a|as)\b/, citricos: /citric|limon|naranj|mandarin|clementin/, nogales: /nogal|nuez|nueces|chandler/,
  cerezos: /cerez|ceres/, avellanos: /avellan/, almendros: /almendr/, manzanos: /manzan/, perales: /\bperas?\b|\bperal/,
  carozos: /durazn|nectarin|damasc|ciruel|carozo/, uva_mesa: /uvas? (de )?mesa|\bu mesa|red glo|crimson|thomson|parron/,
  vinas: /\bvin(a|as|edo|edos|ifer)|sauv|chardon|cabernet|merlot|s[iy]rah|pedro jimenez|pisquera/, olivos: /\boliv(o|os)\b/,
  berries: /arandan|frutilla|berr(y|ies)/, ganaderia: /ganad|engorda|bovino/, forestal: /forestal|eucal|\bpinos?\b/,
  cultivos_anuales: /maiz|esparrag|cultivos? (anuales|tradicionales)|hortaliz/,
};
const FRUTALES = ['paltos', 'citricos', 'nogales', 'cerezos', 'avellanos', 'almendros', 'manzanos', 'perales', 'carozos', 'uva_mesa', 'olivos'];
const ZONAS = {
  rapel: ['las cabras', 'litueche', 'navidad', 'la estrella', 'pichidegua', 'el manzano'],
  melipilla: ['mallarauco', 'cholqui', 'carmen alto', 'carmen bajo', 'bollenar', 'pomaire', 'san pedro', 'longovilo', 'melipilla'],
  colchagua: ['sta cruz', 'nancagua', 'placilla', 'chepica', 'peralillo', 'palmilla', 'lolol', 'marchigue', 'san fernando'],
  leyda: ['sto domingo', 'san antonio', 'cuncumen'],
  chacabuco: ['colina', 'tiltil', 'lampa', 'polpaico'],
  cachapoal: ['requinoa', 'rengo', 'rancagua', 'machali', 'coltauco', 'donihue', 'peumo', 'malloa', 'quinta de tilcoco', 'san vicente'],
  curico: ['teno', 'rauco', 'molina', 'sagrada familia', 'romeral'],
  limari: ['ovalle', 'monte patria', 'punitaqui'],
  elqui: ['vicuna', 'la serena'],
  aconcagua: ['los andes', 'san felipe', 'catemu', 'llay llay', 'san esteban'],
};

// ───────────────────────── Utilidades ─────────────────────────
const id = () => crypto.randomUUID();
const ahora = () => new Date().toISOString();
const txt = (v, max = 2000) => (v == null ? '' : String(v).slice(0, max).trim());
const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\bsanta\b/g, 'sta').replace(/\bsanto\b/g, 'sto').replace(/\s+/g, ' ').trim();
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const usuarioDe = (req) => { let u = req.get('x-crm-user') || ''; try { u = decodeURIComponent(u); } catch (e) {} return txt(u, 80) || 'Equipo'; };

function regionCodigo(t) {
  const s = norm(t).toUpperCase().replace(/[.°º]/g, '').replace(/^(\d{1,2})A$/, '$1');
  if (!s) return '';
  if (s === 'RM' || s.startsWith('METRO') || s === '13') return 'RM';
  if (s.startsWith('AYSEN')) return 'XI';
  const arab = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X', 11: 'XI', 12: 'XII', 14: 'XIV', 15: 'XV', 16: 'XVI' };
  if (/^\d{1,2}$/.test(s)) return arab[Number(s)] || '';
  return REGIONES.includes(s) ? s : '';
}

function expandir(a, b) {
  const i = REGIONES.indexOf(a), j = REGIONES.indexOf(b);
  if (i < 0 || j < 0) return [a, b].filter(Boolean);
  return REGIONES.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function parseRegiones(texto) {
  const s = norm(texto).replace(/\by\b/g, ' ').replace(/-/g, ' - ');
  if (!s) return [];
  const toks = s.split(/[\s,;/]+/).filter(Boolean);
  const out = []; let rango = false, prev = '', codigos = [], huboGuion = false;
  for (const t of toks) {
    if (t === '-' || t === 'a') { rango = true; huboGuion = true; continue; }
    const c = regionCodigo(t);
    if (!c) { rango = false; continue; }
    codigos.push(c);
    if (rango && prev) out.push(...expandir(prev, c)); else out.push(c);
    prev = c; rango = false;
  }
  // "V VII" (dos regiones sueltas) se interpreta como rango
  if (!huboGuion && codigos.length === 2) out.push(...expandir(codigos[0], codigos[1]));
  if (/al sur/.test(s) && codigos.length === 1) out.push(...expandir(codigos[0], 'XII'));
  return [...new Set(out)].sort((a, b) => REGIONES.indexOf(a) - REGIONES.indexOf(b));
}

function regionesEnTexto(texto) {
  const s = norm(texto); const out = [];
  const r = /\b(?:en|region)\s+(xvi|xv|xiv|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|rm)\b|\b(xvi|xiv|xii|xi|ix|viii|vii|vi|iv|iii|rm)\s+region\b|\b(\d{1,2})a\b/g;
  let m; while ((m = r.exec(s))) { const c = regionCodigo(m[1] || m[2] || m[3]); if (c) out.push(c); }
  return [...new Set(out)];
}

function cultivosEn(texto) {
  const s = norm(texto);
  const out = Object.keys(CULTIVOS).filter((k) => CULTIVOS[k].test(s));
  if (/frutal/.test(s)) out.push('frutales');
  return [...new Set(out)];
}

function parseHa(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').match(/\d[\d.,]*/);
  if (!m) return null;
  let t = m[0].replace(/[.,]$/, '');
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function parsePrecio(v) {
  const texto = txt(v, 120);
  const r = { precioTexto: texto, precioCLP: null, precioUF: null };
  if (typeof v === 'number') { if (v >= 1e6) r.precioCLP = v; return r; }
  const s = norm(texto);
  if (!s || /m2|x ha|arriendo|confirmar|revisar/.test(s)) return r;
  const m = s.match(/\d[\d.,]*/); if (!m) return r;
  const limpio = m[0].replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(limpio); if (isNaN(n)) return r;
  if (/\bu[ i]?f\b|\buif\b/.test(s)) r.precioUF = n;
  else if (n >= 1e6) r.precioCLP = n;
  return r;
}

function parseRango(t) {
  const s = norm(t);
  let m;
  if ((m = s.match(/(\d+)\s*(?:-|a)\s*(\d+)/))) return [Number(m[1]), Number(m[2])];
  if ((m = s.match(/hasta\s*(\d+)/))) return [0, Number(m[1])];
  if ((m = s.match(/(\d+)\s*(?:has?\s*)?(?:o\s*mas|omas|\+|y mas)/))) return [Number(m[1]), null];
  if ((m = s.match(/(\d+)/))) { const n = Number(m[1]); return [Math.round(n * 0.75), Math.round(n * 1.25)]; }
  return [null, null];
}

function parseFechaMY(v) {
  if (typeof v === 'number' && v > 20000) { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 7); }
  const m = String(v || '').trim().match(/^(\d{1,2})\s*[\/-]\s*(\d{2,4})$/);
  if (!m) return '';
  const mes = Number(m[1]); let a = Number(m[2]); if (a < 100) a += 2000;
  if (mes < 1 || mes > 12) return '';
  return `${a}-${String(mes).padStart(2, '0')}`;
}

function tipoNorm(t) {
  const s = norm(t);
  if (!s) return '';
  for (const [k, l] of Object.entries(tiposExtra)) if (norm(l) === s || k === s) return k;
  if (/agroindustr|industrial/.test(s)) return 'agroindustrial';
  if (/derechos? de agua/.test(s)) return 'derechos_agua';
  if (/subdivis/.test(s)) return 'loteo';
  if (/lote|parcela/.test(s)) return 'loteo';
  if (/urban/.test(s)) return 'urbano';
  if (/conserv/.test(s)) return 'conservacion';
  if (/energ/.test(s)) return 'energia';
  if (/forest/.test(s) && !/agric/.test(s)) return 'forestal';
  return 'agricola';
}

function fonoNorm(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length === 9 && d.startsWith('9')) return '56' + d;
  if (d.length === 11 && d.startsWith('569')) return d;
  return '';
}

// ───────────────────────── Esquemas ─────────────────────────
const CAMPOS_CAMPO = ['codigo', 'nombre', 'tipo', 'etapa', 'region', 'sector', 'hectareas', 'agua', 'fuenteAgua', 'plantaciones', 'aptitud',
  'precioTexto', 'precioCLP', 'precioUF', 'observaciones', 'corredor', 'asociado', 'propietario', 'telefono', 'email', 'rol', 'linkWeb', 'linkPortal',
  'responsable', 'proximaAccion', 'proximaFecha', 'fechaIngreso', 'estadoPlanilla', 'coordenadas', 'descripcionFicha', 'infraestructura', 'acceso'];
const CAMPOS_CLIENTE = ['nombre', 'contactoNombre', 'telefono', 'email', 'requerimiento', 'tipo', 'regiones', 'zona', 'haMin', 'haMax', 'cultivos',
  'presupuesto', 'operacion', 'observaciones', 'corredor', 'mailing', 'fechaRequerimiento', 'etapa', 'responsable', 'proximaAccion', 'proximaFecha', 'revisar'];
const CAMPOS_TASACION = ['titulo', 'cliente', 'telefono', 'email', 'campoId', 'rol', 'comuna', 'codigo', 'etapa', 'honorariosUF', 'responsable', 'proximaAccion', 'proximaFecha'];

function limpiar(col, b, previo = {}) {
  const o = { ...previo, ...b };
  const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  if (col === 'campos') {
    const r = {};
    for (const k of CAMPOS_CAMPO) r[k] = txt(o[k], k === 'descripcionFicha' ? 8000 : ['observaciones', 'infraestructura'].includes(k) ? 4000 : 400);
    r.tipo = TIPOS.includes(o.tipo) ? o.tipo : tipoNorm(o.tipo) || 'agricola';
    r.etapa = ETAPAS.campos.includes(o.etapa) ? o.etapa : 'Captación';
    r.region = regionCodigo(o.region);
    r.hectareas = num(o.hectareas); r.precioCLP = num(o.precioCLP); r.precioUF = num(o.precioUF);
    r.proximaFecha = fecha(o.proximaFecha);
    r.checklist = {}; for (const [k] of CHECKLIST) r.checklist[k] = !!(o.checklist || {})[k];
    return r;
  }
  if (col === 'clientes') {
    const r = {};
    for (const k of CAMPOS_CLIENTE) r[k] = txt(o[k], ['requerimiento', 'observaciones'].includes(k) ? 4000 : 400);
    r.tipo = TIPOS.includes(o.tipo) ? o.tipo : tipoNorm(o.tipo);
    r.regiones = (Array.isArray(o.regiones) ? o.regiones : parseRegiones(o.regiones)).map(regionCodigo).filter(Boolean);
    r.cultivos = (Array.isArray(o.cultivos) ? o.cultivos : []).filter((c) => CULTIVOS[c] || c === 'frutales');
    r.haMin = num(o.haMin); r.haMax = num(o.haMax);
    r.operacion = o.operacion === 'arriendo' ? 'arriendo' : 'compra';
    r.etapa = ETAPAS.clientes.includes(o.etapa) ? o.etapa : 'Activo';
    r.fechaRequerimiento = /^\d{4}-\d{2}/.test(o.fechaRequerimiento || '') ? o.fechaRequerimiento.slice(0, 10) : '';
    r.proximaFecha = fecha(o.proximaFecha);
    r.revisar = !!o.revisar && o.revisar !== 'false';
    return r;
  }
  const r = {};
  for (const k of CAMPOS_TASACION) r[k] = txt(o[k], 400);
  r.etapa = ETAPAS.tasaciones.includes(o.etapa) ? o.etapa : 'Solicitud';
  r.honorariosUF = num(o.honorariosUF); r.proximaFecha = fecha(o.proximaFecha);
  return r;
}

// ───────────────────────── Match ─────────────────────────
function lugaresDe(campo) {
  const sector = norm(campo.sector);
  const out = sector.length >= 4 ? [sector] : [];
  for (const [zona, lista] of Object.entries(ZONAS)) if (lista.includes(sector)) out.push(zona);
  return out;
}

function cultivosCampo(c) {
  const out = cultivosEn(`${c.plantaciones} ${c.aptitud} ${c.observaciones}`);
  if (/ganad/.test(norm(c.tipo + ' ' + c.aptitud))) out.push('ganaderia');
  return [...new Set(out.filter((x) => x !== 'frutales'))];
}

const COMPAT = {
  agricola: { agricola: 10 }, loteo: { loteo: 10, urbano: 5, agricola: 3 }, urbano: { urbano: 10, loteo: 5 },
  forestal: { forestal: 10, conservacion: 5, agricola: 3 }, conservacion: { conservacion: 10, forestal: 5, agricola: 3 }, energia: { energia: 10, agricola: 3 },
  agroindustrial: { agroindustrial: 10, agricola: 3 }, derechos_agua: { derechos_agua: 10 },
};
const NOMBRE_CULTIVO = { paltos: 'paltos', citricos: 'cítricos', nogales: 'nogales', cerezos: 'cerezos', avellanos: 'avellanos', almendros: 'almendros',
  manzanos: 'manzanos', perales: 'perales', carozos: 'carozos', uva_mesa: 'uva de mesa', vinas: 'viñas', olivos: 'olivos', berries: 'berries',
  ganaderia: 'ganadería', forestal: 'forestal', cultivos_anuales: 'cultivos anuales', frutales: 'frutales' };

function evaluar(campo, cli, hoy = new Date()) {
  // tipo
  let sTipo;
  if (!cli.tipo) sTipo = 5;
  else { sTipo = (COMPAT[cli.tipo] || { [cli.tipo]: 10 })[campo.tipo]; if (sTipo == null) return null; }
  const razones = [], alertas = [];
  const textoCli = norm(`${cli.zona} ${cli.requerimiento} ${cli.observaciones}`);
  const lugares = lugaresDe(campo);
  const hitZona = lugares.find((l) => new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(textoCli));
  let conocidos = 0;

  // lugar (35)
  let sLugar;
  const tieneRegion = cli.regiones && cli.regiones.length;
  if (tieneRegion) conocidos++;
  if (tieneRegion && campo.region && cli.regiones.includes(campo.region)) { sLugar = 25; razones.push(`Busca en región ${campo.region}`); }
  else if (tieneRegion && campo.region && !hitZona) return null;
  else sLugar = hitZona ? 25 : 17;
  if (hitZona) {
    sLugar = Math.min(35, sLugar + 10);
    const etiquetaZona = hitZona === norm(campo.sector) ? campo.sector.trim() : hitZona.replace(/\b\w/g, (x) => x.toUpperCase());
    razones.push(`Menciona ${etiquetaZona}`);
  }

  // cultivos (30)
  let sCult = 15;
  const cc = cultivosCampo(campo), ck = cli.cultivos || [];
  if (ck.length) conocidos++;
  if (ck.length && cc.length && !['loteo', 'urbano'].includes(campo.tipo)) {
    const inter = ck.filter((x) => cc.includes(x));
    if (inter.length) { sCult = 30; razones.push(`Busca ${inter.map((x) => NOMBRE_CULTIVO[x]).join(', ')}`); }
    else if (ck.includes('frutales') && cc.some((x) => FRUTALES.includes(x))) { sCult = 22; razones.push('Busca frutales'); }
    else return null;
  }

  // superficie (25)
  let sSup = 12;
  const ha = campo.hectareas;
  if (cli.haMin != null || cli.haMax != null) {
    conocidos++;
    if (ha != null) {
      const min = cli.haMin || 0, max = cli.haMax == null ? Infinity : cli.haMax;
      const txtRango = cli.haMax == null ? `${min}+ ha` : `${min}–${max} ha`;
      if (ha >= min && ha <= max) { sSup = 25; razones.push(`Superficie calza (${txtRango})`); }
      else if (ha >= min * 0.75 && ha <= max * 1.25) { sSup = 12; alertas.push(`Superficie algo fuera de rango (busca ${txtRango})`); }
      else { sSup = 0; alertas.push(`Superficie fuera de rango (busca ${txtRango})`); }
    }
  }

  if (!hitZona && conocidos < 2) return null;
  const score = sTipo + sLugar + sCult + sSup;
  if (score < 55) return null;
  if (cli.operacion === 'arriendo') alertas.push('Busca arriendo');
  if (cli.presupuesto) razones.push(`Presupuesto: ${cli.presupuesto}`);
  if (cli.fechaRequerimiento) {
    const meses = (hoy.getFullYear() - Number(cli.fechaRequerimiento.slice(0, 4))) * 12 + (hoy.getMonth() + 1 - Number(cli.fechaRequerimiento.slice(5, 7)));
    if (meses > 24) alertas.push(`Requerimiento de ${cli.fechaRequerimiento.slice(0, 4)}, reconfirmar`);
  }
  return { clienteId: cli.id, score, nivel: score >= 70 ? 'fuerte' : 'parcial', razones, alertas };
}

function calcularMatches(db) {
  const out = {};
  const clientes = db.clientes.filter((c) => c.etapa === 'Activo');
  for (const campo of db.campos) {
    if (['Vendido', 'Descartado', 'Prospección', 'Retirado de la web'].includes(campo.etapa)) continue;
    const lista = [];
    for (const cli of clientes) { const r = evaluar(campo, cli); if (r) lista.push(r); }
    if (lista.length) out[campo.id] = lista.sort((a, b) => b.score - a.score);
  }
  return out;
}

// ───────────────────────── Importación de la planilla ─────────────────────────
function mapaEncabezados(fila) {
  const m = {};
  fila.forEach((h, i) => { const k = norm(h); if (k && m[k] == null) m[k] = i; });
  return m;
}
const get = (fila, m, ...nombres) => { for (const n of nombres) if (m[n] != null) { const v = fila[m[n]]; if (v !== '' && v != null) return v; } return ''; };

function importarHojas(hojas) {
  const campos = [], clientes = [], resumen = { campos: 0, captacion: 0, prospeccion: 0, clientes: 0, clientesRevisar: 0, hojasIgnoradas: [] };
  const nuevo = (extra) => ({ id: id(), creado: ahora(), actualizado: ahora(), historial: [{ fecha: ahora(), autor: 'Importación', texto: 'Importado desde la planilla' }], envios: [], ...extra });
  const ESTADO = { activo: 'Publicado', vendido: 'Vendido', suspendido: 'Suspendido', arrendado: 'Arrendado', mandato: 'Mandato firmado', publicar: 'Documentación' };

  for (const hoja of hojas || []) {
    const filas = (hoja.filas || []).map((f) => (Array.isArray(f) ? f : []));
    const iH = filas.findIndex((f) => { const m = mapaEncabezados(f); return (m.cliente != null && m.requerimiento != null) || (m.has != null && m['tipo propiedad'] != null) || (m.rol != null && m['razon social'] != null); });
    if (iH < 0) { resumen.hojasIgnoradas.push(hoja.nombre || '(sin nombre)'); continue; }
    const m = mapaEncabezados(filas[iH]);
    const datos = filas.slice(iH + 1).filter((f) => f.some((c) => String(c ?? '').trim()));

    if (m.cliente != null) {
      const colFecha = filas[iH].findIndex((h) => !String(h ?? '').trim());
      for (const f of datos) {
        const nombre = txt(get(f, m, 'cliente'), 200); if (!nombre) continue;
        const req = txt(get(f, m, 'requerimiento'), 4000), obs = txt(get(f, m, 'observaciones'), 4000), zona = txt(get(f, m, 'zona especifica'), 400);
        let regiones = parseRegiones(get(f, m, 'regiones'));
        if (!regiones.length) regiones = regionesEnTexto(`${req} ${zona}`);
        const sup = txt(get(f, m, 'superficie')); const [haMin, haMax] = parseRango(sup || (/\d+\s*(has?|-)/.test(norm(req)) ? req : ''));
        const cultivos = cultivosEn(`${req} ${obs}`);
        const contacto = txt(get(f, m, 'contacto'), 200);
        const esFono = /^\+?[\d\s]{8,}$/.test(contacto);
        const reP = /(hasta|ppto\.?|presupuesto)\s*(uf\s*)?\$?\s*\d[\d.,]*\s*(mm\b|millones|uf\b|mil\b)?/i;
        const mP = obs.match(reP) || req.match(reP);
        const presupuesto = mP && (mP[2] || mP[3]) ? mP[0] : '';
        const faltan = [!regiones.length && !zona, !cultivos.length, haMin == null && haMax == null].filter(Boolean).length;
        const c = nuevo({
          nombre, requerimiento: req, observaciones: obs, zona, regiones, cultivos, haMin, haMax, presupuesto: txt(presupuesto, 200),
          tipo: tipoNorm(get(f, m, 'tipo')), operacion: /arriend/.test(norm(req)) ? 'arriendo' : 'compra',
          contactoNombre: esFono ? '' : contacto, telefono: esFono ? contacto : '', email: txt(get(f, m, 'email'), 400),
          corredor: txt(get(f, m, 'corredor'), 40), mailing: txt(get(f, m, 'lista mailing'), 60),
          fechaRequerimiento: parseFechaMY(colFecha >= 0 ? f[colFecha] : ''), etapa: 'Activo', revisar: faltan >= 2,
        });
        clientes.push(c); resumen.clientes++; if (c.revisar) resumen.clientesRevisar++;
      }
      continue;
    }

    if (m.rol != null && m['razon social'] != null) {
      for (const f of datos) {
        const rol = txt(get(f, m, 'rol'), 60), razon = txt(get(f, m, 'razon social'), 200), comuna = txt(get(f, m, 'comuna'), 120);
        if (!rol && !razon && !comuna) continue;
        campos.push(nuevo({
          nombre: razon || [comuna, rol].filter(Boolean).join(' ') || 'Prospecto', rol, sector: comuna, etapa: 'Prospección',
          hectareas: parseHa(get(f, m, 'has')), tipo: tipoNorm(get(f, m, 'tipo')) || 'agricola', observaciones: [get(f, m, 'observaciones'), get(f, m, 'otros')].filter(Boolean).join('\n'),
          propietario: txt(get(f, m, 'contacto'), 200), telefono: txt(get(f, m, 'fono'), 60), email: txt(get(f, m, 'email'), 200), checklist: {},
        }));
        resumen.prospeccion++;
      }
      continue;
    }

    const esCartera = m.codigo != null;
    for (const f of datos) {
      const nombre = txt(get(f, m, 'nombre'), 200), sector = txt(get(f, m, 'sector'), 120);
      if (!nombre && !sector) continue;
      const estado = norm(get(f, m, 'estado'));
      const etapa = esCartera ? (ESTADO[estado] || 'Publicado') : (estado === 'mandato' ? 'Mandato firmado' : 'Captación');
      const links = [get(f, m, 'link fb'), get(f, m, 'link')].map((x) => txt(x, 400)).filter((x) => /^https?:\/\//.test(x));
      const codigo = txt(get(f, m, 'codigo'), 40);
      campos.push(nuevo({
        codigo: /^publicar$/i.test(codigo) ? '' : codigo, nombre: nombre || sector, sector, etapa, estadoPlanilla: txt(get(f, m, 'estado'), 40),
        tipo: tipoNorm(get(f, m, 'tipo propiedad')) || 'agricola', region: regionCodigo(get(f, m, 'region')), hectareas: parseHa(get(f, m, 'has')),
        agua: txt(get(f, m, 'derechos de agua'), 200), fuenteAgua: txt(get(f, m, 'fuente'), 200), plantaciones: txt(get(f, m, 'plantaciones'), 400),
        aptitud: txt(get(f, m, 'aptitud'), 200), ...parsePrecio(get(f, m, 'precio')), observaciones: txt(get(f, m, 'observaciones'), 4000),
        corredor: txt(get(f, m, 'corredor'), 40), asociado: txt(get(f, m, 'asociado'), 120),
        propietario: txt(get(f, m, 'contacto'), 200), telefono: txt(get(f, m, 'fono'), 60), email: esCartera ? '' : txt(get(f, m, 'email'), 200),
        linkWeb: links[0] || '', linkPortal: links[1] || '', fechaIngreso: parseFechaMY(get(f, m, 'fecha')),
        checklist: { publicacion: esCartera && etapa === 'Publicado' && links.length > 0 },
      }));
      if (esCartera) resumen.campos++; else resumen.captacion++;
    }
  }
  return {
    campos: campos.map((c) => ({ ...c, ...limpiar('campos', c) })),
    clientes: clientes.map((c) => ({ ...c, ...limpiar('clientes', c) })),
    resumen,
  };
}

// ───────────────────────── Almacenamiento ─────────────────────────
function vacio() { return { campos: [], clientes: [], tasaciones: [], actividad: [] }; }
function leer() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); tiposExtra = d.tiposExtra || {}; return { ...vacio(), ...d }; }
  catch (e) { return vacio(); }
}
function guardar(db) {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    for (let i = 2; i >= 1; i--) { const a = `${FILE}.bak${i}`, b = `${FILE}.bak${i + 1}`; if (fs.existsSync(a)) fs.renameSync(a, b); }
    fs.copyFileSync(FILE, `${FILE}.bak1`);
  }
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
let cola = Promise.resolve();
function modificar(fn) {
  const p = cola.then(() => { const db = leer(); const r = fn(db); guardar(db); return r; });
  cola = p.catch(() => {});
  return p;
}
function registrar(db, autor, texto, ref) {
  db.actividad.unshift({ fecha: ahora(), autor, texto, ref });
  if (db.actividad.length > 500) db.actividad.length = 500;
}
const etiqueta = (col, x) => (col === 'campos' ? x.nombre : col === 'clientes' ? x.nombre : x.titulo) || 'sin nombre';

// ───────────────────────── Rutas ─────────────────────────
router.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/publico/') || req.path.startsWith('/publico-plano/') || req.path === '/publico-img') return next();
  const clave = process.env.CRM_KEY;
  if (!clave) return res.status(500).json({ error: 'Falta la variable CRM_KEY en Railway.' });
  if (req.get('x-crm-key') !== clave) return res.status(401).json({ error: 'Clave del equipo incorrecta.' });
  next();
});

router.get('/', (req, res) => {
  const db = leer();
  res.json({ version: VERSION, etapas: ETAPAS, checklist: CHECKLIST, activas: CAMPO_ACTIVAS, ofrecibles: CAMPO_OFRECIBLES,
    cultivos: NOMBRE_CULTIVO, regiones: REGIONES, tipos: todosLosTipos(), syncEnCurso: !!sincronizando, acuerdo: textoAcuerdo(db), campos: db.campos, clientes: db.clientes, tasaciones: db.tasaciones, sync: db.sync || null,
    actividad: db.actividad.slice(0, 150), matches: calcularMatches(db) });
});

for (const col of ['campos', 'clientes', 'tasaciones']) {
  const singular = { campos: 'campo', clientes: 'cliente', tasaciones: 'tasación' }[col];

  router.post(`/${col}`, async (req, res) => {
    const autor = usuarioDe(req);
    const d = limpiar(col, req.body || {});
    if (!etiqueta(col, d) || etiqueta(col, d) === 'sin nombre') return res.status(400).json({ error: `El ${singular} necesita un nombre.` });
    const nuevo = { id: id(), ...d, historial: [{ fecha: ahora(), autor, texto: `Creado en etapa ${d.etapa}` }], envios: [], creado: ahora(), actualizado: ahora() };
    await modificar((db) => { db[col].push(nuevo); registrar(db, autor, `Creó ${singular} ${etiqueta(col, d)}`, { col, id: nuevo.id }); });
    res.json(nuevo);
  });

  router.put(`/${col}/:id`, async (req, res) => {
    const autor = usuarioDe(req);
    const r = await modificar((db) => {
      const i = db[col].findIndex((x) => x.id === req.params.id);
      if (i < 0) return null;
      const prev = db[col][i];
      const upd = limpiar(col, req.body || {}, prev);
      const historial = [...(prev.historial || [])];
      if (upd.etapa !== prev.etapa) {
        historial.push({ fecha: ahora(), autor, texto: `Etapa: ${prev.etapa} → ${upd.etapa}` });
        registrar(db, autor, `${etiqueta(col, upd)}: ${prev.etapa} → ${upd.etapa}`, { col, id: prev.id });
      }
      if (col === 'campos') for (const [k, l] of CHECKLIST) if (!!(prev.checklist || {})[k] !== upd.checklist[k]) {
        historial.push({ fecha: ahora(), autor, texto: `${upd.checklist[k] ? 'Listo' : 'Pendiente'}: ${l}` });
        if (upd.checklist[k]) registrar(db, autor, `${etiqueta(col, upd)}: ${l} listo`, { col, id: prev.id });
      }
      if (upd.proximaAccion !== prev.proximaAccion || upd.proximaFecha !== prev.proximaFecha) {
        if (upd.proximaAccion) historial.push({ fecha: ahora(), autor, texto: `Próxima acción: ${upd.proximaAccion}${upd.proximaFecha ? ` (${upd.proximaFecha})` : ''}` });
      }
      db[col][i] = { ...prev, ...upd, historial, actualizado: ahora() };
      return db[col][i];
    });
    r ? res.json(r) : res.status(404).json({ error: `No se encontró el ${singular}.` });
  });

  router.post(`/${col}/:id/nota`, async (req, res) => {
    const texto = txt((req.body || {}).texto, 4000);
    if (!texto) return res.status(400).json({ error: 'La nota está vacía.' });
    const autor = usuarioDe(req);
    const r = await modificar((db) => {
      const x = db[col].find((y) => y.id === req.params.id);
      if (!x) return null;
      x.historial = [...(x.historial || []), { fecha: ahora(), autor, texto }]; x.actualizado = ahora();
      registrar(db, autor, `Nota en ${etiqueta(col, x)}: ${texto.slice(0, 80)}`, { col, id: x.id });
      return x;
    });
    r ? res.json(r) : res.status(404).json({ error: `No se encontró el ${singular}.` });
  });

  router.delete(`/${col}/:id`, async (req, res) => {
    const autor = usuarioDe(req);
    const r = await modificar((db) => {
      const x = db[col].find((y) => y.id === req.params.id);
      if (!x) return false;
      db[col] = db[col].filter((y) => y.id !== req.params.id);
      registrar(db, autor, `Eliminó ${singular} ${etiqueta(col, x)}`, null);
      return true;
    });
    r ? res.json({ ok: true }) : res.status(404).json({ error: `No se encontró el ${singular}.` });
  });
}

// Registrar envío de un campo a clientes
router.post('/campos/:id/envio', async (req, res) => {
  const autor = usuarioDe(req);
  const ids = Array.isArray((req.body || {}).clienteIds) ? req.body.clienteIds.map(String) : [];
  const canal = ['correo', 'whatsapp'].includes(req.body.canal) ? req.body.canal : 'otro';
  if (!ids.length) return res.status(400).json({ error: 'No hay clientes seleccionados.' });
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id);
    if (!campo) return null;
    const nombres = [];
    for (const cid of ids) {
      const cli = db.clientes.find((x) => x.id === cid); if (!cli) continue;
      campo.envios = [...(campo.envios || []), { clienteId: cid, fecha: ahora(), autor, canal }];
      cli.historial = [...(cli.historial || []), { fecha: ahora(), autor, texto: `Se le envió ${campo.nombre} por ${canal}` }];
      nombres.push(cli.nombre);
    }
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: `Enviado por ${canal} a ${nombres.join(', ')}` }];
    registrar(db, autor, `Envió ${campo.nombre} a ${nombres.length} cliente${nombres.length === 1 ? '' : 's'} por ${canal}`, { col: 'campos', id: campo.id });
    return campo;
  });
  r ? res.json(r) : res.status(404).json({ error: 'No se encontró el campo.' });
});

// Importar la planilla (hojas como filas de celdas)
router.post('/importar', async (req, res) => {
  const autor = usuarioDe(req);
  const { campos, clientes, resumen } = importarHojas((req.body || {}).hojas);
  if (!campos.length && !clientes.length) return res.status(400).json({ error: 'No se reconoció ninguna hoja. Revisa que las columnas tengan sus encabezados (Cliente, Requerimiento, Has, Tipo Propiedad…).', resumen });
  const reemplazar = (req.body || {}).modo === 'reemplazar';
  await modificar((db) => {
    if (reemplazar) { db.campos = []; db.clientes = []; }
    db.campos.push(...campos); db.clientes.push(...clientes);
    registrar(db, autor, `Importó la planilla: ${resumen.campos + resumen.captacion + resumen.prospeccion} campos y ${resumen.clientes} clientes`, null);
  });
  res.json({ ok: true, resumen });
});


// ───────────────────────── Captación: link del propietario y mandato ─────────────────────────
// Texto del mandato basado en el modelo "Mandato de Venta Campos Ñiquen" de Farm Brokers Chile SpA.
const CORREDOR = {
  razon: 'FARM BROKERS CHILE SPA', rut: '77.089.307-0',
  representante: 'don Daniel Haeussler Bobillier, Rut 13.660.318-3',
  domicilio: 'Estoril N° 120 of. 615, Comuna de Las Condes',
  pie: 'www.farmbrokers.cl · Phone +569 7193 90 40 · Email: contacto@farmbrokers.cl',
};
const REGION_TEXTO = { XV: 'Región de Arica y Parinacota', I: 'Región de Tarapacá', II: 'Región de Antofagasta', III: 'Región de Atacama',
  IV: 'Región de Coquimbo', V: 'Región de Valparaíso', RM: 'Región Metropolitana', VI: "Región del Libertador General Bernardo O'Higgins",
  VII: 'Región del Maule', XVI: 'Región de Ñuble', VIII: 'Región del Biobío', IX: 'Región de La Araucanía', XIV: 'Región de Los Ríos',
  X: 'Región de Los Lagos', XI: 'Región de Aysén', XII: 'Región de Magallanes' };
const TIPO_PREDIO = { agricola: 'Campo agrícola', loteo: 'Campo loteo', parcela: 'Parcela', forestal: 'Campo forestal', ganadero: 'Campo ganadero' };
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const TIPOS_ARCHIVO = ['kmz', 'foto', 'dominio', 'hipotecas', 'avaluo', 'aguas', 'plano', 'otro'];

function rutLimpio(r) { return String(r || '').replace(/[^0-9kK]/g, '').toUpperCase(); }
function rutValido(r) {
  const c = rutLimpio(r); if (c.length < 2) return false;
  const cuerpo = c.slice(0, -1), dv = c.slice(-1);
  let suma = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { suma += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
  const r11 = 11 - (suma % 11), esperado = r11 === 11 ? '0' : r11 === 10 ? 'K' : String(r11);
  return dv === esperado;
}
function rutFormato(r) {
  const c = rutLimpio(r); if (c.length < 2) return String(r || '');
  return `${c.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${c.slice(-1)}`;
}
const miles = (n) => Math.round(Number(n)).toLocaleString('es-CL');
const decimal = (n) => Number(n).toLocaleString('es-CL', { maximumFractionDigits: 2 });
const monto = (v, moneda) => (moneda === 'UF' ? `UF ${decimal(v)}` : `$${miles(v)}`);

function limpiarDatosPropietario(b, previo = {}) {
  const o = { ...previo, ...(b || {}) };
  const t = (v, n = 300) => txt(v, n);
  const trat = (v) => (v === 'don' || v === 'doña' ? v : '');
  const v = o.vendedor || {};
  const vendedor = {
    tipo: v.tipo === 'empresa' ? 'empresa' : 'natural',
    personas: (Array.isArray(v.personas) ? v.personas : []).slice(0, 6).map((p) => ({ trat: trat(p.trat), nombre: t(p.nombre, 160), rut: t(p.rut, 20) })),
    empresa: { razon: t((v.empresa || {}).razon, 200), rut: t((v.empresa || {}).rut, 20), repTrat: trat((v.empresa || {}).repTrat), repNombre: t((v.empresa || {}).repNombre, 160), repRut: t((v.empresa || {}).repRut, 20) },
    telefono: t(v.telefono, 40), email: t(v.email, 160),
  };
  if (!vendedor.personas.length) vendedor.personas = [{ trat: '', nombre: '', rut: '' }];
  const predios = (Array.isArray(o.predios) ? o.predios : []).slice(0, 10).map((p) => ({
    tipo: TIPO_PREDIO[p.tipo] ? p.tipo : 'agricola', rol: t(p.rol, 30), comuna: t(p.comuna, 80), region: REGION_TEXTO[p.region] ? p.region : '',
    hectareas: num(String(p.hectareas ?? '').replace(',', '.')), descripcion: t(p.descripcion, 400),
    lotes: num(p.lotes), lotesVenta: num(p.lotesVenta), m2Lote: num(p.m2Lote), planoSAG: !!p.planoSAG,
    tieneAgua: !!p.tieneAgua, aguaDetalle: t(p.aguaDetalle, 300),
    moneda: p.moneda === 'UF' ? 'UF' : 'CLP', precio: num(String(p.precio ?? '').replace(/\./g, '').replace(',', '.')),
  }));
  if (!predios.length) predios.push(limpiarDatosPropietario({ predios: [{}] }).predios[0]);
  return {
    vendedor, predios, infraestructura: t(o.infraestructura, 600), sinPrecio: !!o.sinPrecio, comentarios: t(o.comentarios, 2000),
    ventaSeparada: o.ventaSeparada !== false, pasoActual: Math.max(0, Math.min(5, Number(o.pasoActual) || 0)),
  };
}

function faltantesMandato(d) {
  const f = [];
  const v = d.vendedor;
  if (v.tipo === 'empresa') {
    if (!v.empresa.razon) f.push('Razón social del vendedor');
    if (!rutValido(v.empresa.rut)) f.push('RUT válido de la sociedad');
    if (!v.empresa.repNombre) f.push('Nombre del representante');
    if (!rutValido(v.empresa.repRut)) f.push('RUT válido del representante');
    if (!v.empresa.repTrat) f.push('Tratamiento del representante (don o doña)');
  } else v.personas.forEach((p, i) => {
    const q = v.personas.length > 1 ? ` (propietario ${i + 1})` : '';
    if (!p.nombre) f.push(`Nombre completo${q}`);
    if (!rutValido(p.rut)) f.push(`RUT válido${q}`);
    if (!p.trat) f.push(`Tratamiento, don o doña${q}`);
  });
  d.predios.forEach((p, i) => {
    const q = d.predios.length > 1 ? ` del predio ${i + 1}` : '';
    if (!p.rol) f.push(`Rol SII${q}`);
    if (!p.comuna) f.push(`Comuna${q}`);
    if (!p.region) f.push(`Región${q}`);
    if (!p.hectareas) f.push(`Superficie${q}`);
    if (!d.sinPrecio && !p.precio) f.push(`Precio${q}`);
    if (p.tieneAgua && !p.aguaDetalle) f.push(`Detalle de los derechos de agua${q}`);
    if (p.tipo === 'loteo' && p.lotesVenta && p.lotes && p.lotesVenta > p.lotes) f.push(`Los lotes a la venta no pueden ser más que el total de lotes${q}`);
  });
  if (d.sinPrecio) f.push('Precio de venta (se definirá con la tasación)');
  return f;
}

function fechaLarga(d) { return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`; }

function bloquesMandato(campo, fecha = new Date()) {
  const cap = campo.captacion, d = cap.datos, cfg = cap.config;
  const B = (t) => ({ t, b: true }), N = (t) => ({ t });
  const varios = d.predios.length > 1;
  const vend = [];
  if (d.vendedor.tipo === 'empresa') {
    const e = d.vendedor.empresa;
    vend.push(N('la sociedad '), B(e.razon.toUpperCase()), N(`, rol único tributario N° ${rutFormato(e.rut)}, representada por ${e.repTrat} ${e.repNombre}, cédula nacional de identidad N° ${rutFormato(e.repRut)}`));
  } else d.vendedor.personas.forEach((p, i, arr) => {
    if (i > 0) vend.push(N(i === arr.length - 1 ? ' y ' : ', '));
    vend.push(N(`${p.trat} `), B(p.nombre.toUpperCase()), N(`, cédula nacional de identidad N° ${rutFormato(p.rut)}`));
  });
  const bloques = [
    { k: 'titulo', runs: [N(`MANDATO DE VENTA ${String(cfg.titulo || campo.nombre).toUpperCase()}`)] },
    { k: 'p', runs: [N(`En ${cfg.ciudad || 'Santiago'}, a ${fechaLarga(fecha)}, `), ...vend,
      N(', en adelante “El Vendedor”, mediante el presente documento, otorga mandato de venta a '), B(CORREDOR.razon),
      N(`, rol único tributario Nº ${CORREDOR.rut}, representada por ${CORREDOR.representante}, con domicilio en ${CORREDOR.domicilio}, en adelante “El Corredor”, para gestionar y mediar la venta de lo(s) siguiente(s) inmueble(s):`)] },
  ];
  const items = d.predios.map((p) => {
    let t = `${TIPO_PREDIO[p.tipo]} ubicado en la Comuna de ${p.comuna}, ${REGION_TEXTO[p.region]}`;
    if (p.descripcion) t += `, ${p.descripcion.replace(/[.\s]+$/, '')}`;
    t += `, con una superficie aproximada de ${decimal(p.hectareas)} hectáreas`;
    if (p.tipo === 'loteo' && p.lotes) t += `, subdividido en ${miles(p.lotes)} lotes${p.m2Lote ? ` de ${miles(p.m2Lote)} m²` : ''}${p.planoSAG ? ' con plano de subdivisión aprobado por el SAG' : ''}`;
    return `${t}. Rol SII: ${p.rol}, Comuna de ${p.comuna}.`;
  });
  const conAgua = d.predios.filter((p) => p.tieneAgua);
  if (!conAgua.length) items.push(varios ? 'Ninguno de los predios cuenta con derechos de aprovechamiento de aguas.' : 'El predio no cuenta con derechos de aprovechamiento de aguas.');
  else conAgua.forEach((p) => items.push(`${varios ? `El predio Rol ${p.rol}` : 'El predio'} cuenta con derechos de aprovechamiento de aguas: ${p.aguaDetalle.replace(/[.\s]+$/, '')}.`));
  bloques.push({ k: 'lista', items });
  bloques.push({ k: 'p', runs: [N(`Infraestructura: ${d.infraestructura ? d.infraestructura.replace(/[.\s]+$/, '') : 'No tiene'}.`)] });
  const hayLoteo = d.predios.some((p) => p.tipo === 'loteo' && p.lotes);
  bloques.push({ k: 'p', runs: [N(`${varios && d.ventaSeparada ? `Los predios podrán venderse en conjunto o por separado${hayLoteo ? ', y los lotes del campo loteo también en forma individual' : ''}. ` : hayLoteo ? 'Los lotes podrán venderse en forma individual. ' : ''}Los términos de venta son los siguientes:`)] });
  bloques.push({ k: 'sub', runs: [N('1. PRECIO')] });
  d.predios.forEach((p) => {
    const runs = [B(`${TIPO_PREDIO[p.tipo]} (Rol ${p.rol}): ${monto(p.precio, p.moneda)}`)];
    const nVenta = p.lotesVenta || p.lotes;
    if (p.tipo === 'loteo' && nVenta) runs.push(N(` por los ${miles(nVenta)} lotes, equivalente a ${monto(p.precio / nVenta, p.moneda)} por lote.`));
    bloques.push({ k: 'p', runs });
  });
  bloques.push({ k: 'p', runs: [N('El monto final a pagar “al Vendedor” deberá documentarse mediante vale vista al momento de la firma del contrato final de compraventa, quedando con instrucciones de pago en notaría una vez inscritos los inmuebles a nombre del comprador en el CBR correspondiente.')] });
  bloques.push({ k: 'sub', runs: [N('2. VIGENCIA')] });
  bloques.push({ k: 'p', runs: [N(`El presente mandato tendrá un plazo de vigencia de ${miles(cfg.vigencia)} días a partir de esta fecha y será renovable automáticamente por períodos sucesivos hasta que alguna de las partes quiera poner término.`)] });
  bloques.push({ k: 'sub', runs: [N('3. COMISIÓN')] });
  bloques.push({ k: 'p', runs: [N(`En caso de que la gestión de venta de ${varios ? 'los predios' : 'el predio'} haya sido efectuada por el “Corredor”, el “Vendedor” se compromete a pagar al “Corredor” una comisión de ${decimal(cfg.comision)}% del precio final de compraventa de ${varios ? 'las propiedades' : 'la propiedad'}. El monto final a pagar de dicha comisión deberá documentarse mediante cheque o vale vista al momento de la firma del contrato final de compraventa, quedando con instrucciones de pago en notaría.`)] });
  bloques.push({ k: 'sub', runs: [N('4. RESPONSABILIDAD')] });
  bloques.push({ k: 'p', runs: [N('“El Vendedor” asume la responsabilidad de entregar oportunamente todos los antecedentes técnicos, legales y comerciales que sean necesarios para confeccionar el contrato de compraventa.')] });
  bloques.push({ k: 'sub', runs: [N('5. EXCLUSIVIDAD')] });
  bloques.push({ k: 'p', runs: [N('El presente mandato NO constituye exclusividad de venta de la propiedad hacia el “Corredor”, por lo que “el Vendedor” tiene facultades para gestionar la venta del predio por otros medios.')] });
  bloques.push({ k: 'sub', runs: [N('6. CONFIDENCIALIDAD')] });
  bloques.push({ k: 'p', runs: [N('Ambas partes se obligan para sí y por los trabajadores que destinen en el marco de estas conversaciones, a mantener la más estricta confidencialidad respecto de toda información y documentación legal que las partes tengan acceso, quedándoles estrictamente prohibido la divulgación a cualquier tercero, así como la utilización de tal información o conocimiento en cualquier otra actividad ya sea en beneficio propio o de terceros, salvo consentimiento previo, expreso y por escrito de la contraparte. No obstante, “el Vendedor” autoriza al “Corredor” para realizar publicaciones con información comercial de venta de la(s) propiedad(es).')] });
  const firmantes = d.vendedor.tipo === 'empresa'
    ? [`${d.vendedor.empresa.razon}, representada por ${d.vendedor.empresa.repNombre}`]
    : d.vendedor.personas.map((p) => p.nombre);
  bloques.push({ k: 'firmas', vendedor: firmantes, corredor: 'Farm Brokers Chile SPA' });
  return bloques;
}
const hashBloques = (b) => crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
const nombreVendedor = (d) => (d.vendedor.tipo === 'empresa' ? d.vendedor.empresa.razon : d.vendedor.personas.map((p) => p.nombre).filter(Boolean).join(' y '));

// Copia al campo del CRM lo que entregó el propietario (sin pisar datos con vacíos)
function volcarAlCampo(campo, d) {
  const ps = d.predios.filter((p) => p.rol || p.comuna || p.hectareas);
  if (!ps.length) return;
  const set = (k, v) => { if (v !== '' && v != null) campo[k] = v; };
  set('propietario', nombreVendedor(d)); set('telefono', d.vendedor.telefono); set('email', d.vendedor.email);
  set('rol', ps.map((p) => p.rol).filter(Boolean).join(', '));
  set('sector', ps[0].comuna); set('region', ps[0].region);
  const ha = ps.reduce((s, p) => s + (p.hectareas || 0), 0); if (ha) campo.hectareas = Math.round(ha * 100) / 100;
  if (!d.sinPrecio && ps.every((p) => p.precio && p.moneda === ps[0].moneda)) {
    const tot = ps.reduce((s, p) => s + p.precio, 0);
    if (ps[0].moneda === 'UF') { campo.precioUF = tot; campo.precioCLP = null; } else { campo.precioCLP = tot; campo.precioUF = null; }
    campo.precioTexto = monto(tot, ps[0].moneda);
  }
  const aguas = ps.filter((p) => p.tieneAgua && p.aguaDetalle).map((p) => p.aguaDetalle);
  set('agua', aguas.length ? aguas.join('; ') : 'Sin derechos de agua');
  if (ps.some((p) => p.tipo === 'loteo')) campo.tipo = 'loteo';
  set('infraestructura', d.infraestructura);
}

function publicoDe(campo) {
  const cap = campo.captacion;
  return {
    titulo: cap.config.titulo || campo.nombre, estado: cap.estado, config: { comision: cap.config.comision, vigencia: cap.config.vigencia },
    datos: cap.datos, archivos: (campo.archivos || []).filter((a) => a.origen === 'propietario').map(({ id, tipo, nombre, tamano, fecha }) => ({ id, tipo, nombre, tamano, fecha })),
    faltan: faltantesMandato(cap.datos),
    firma: cap.firma ? { nombre: cap.firma.nombre, rut: cap.firma.rut, fecha: cap.firma.fecha, codigo: cap.firma.hash.slice(0, 12).toUpperCase() } : null,
  };
}
const buscarPorToken = (db, token) => (/^[a-f0-9]{32}$/.test(token) ? db.campos.find((c) => c.captacion && c.captacion.token === token) : null);
const ipDe = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();

// ── Equipo: crear o actualizar el link del propietario
router.post('/campos/:id/captacion', async (req, res) => {
  const autor = usuarioDe(req);
  const b = req.body || {};
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id);
    if (!campo) return null;
    const previo = campo.captacion;
    if (previo && previo.firma) return { error: 'El mandato ya está firmado. No se puede cambiar la configuración.' };
    const config = {
      comision: Math.max(0, Math.min(20, Number(b.comision) || (previo && previo.config.comision) || 2)),
      vigencia: Math.max(1, Math.min(3650, Math.round(Number(b.vigencia) || (previo && previo.config.vigencia) || 180))),
      ciudad: txt(b.ciudad || (previo && previo.config.ciudad) || 'Santiago', 60),
      titulo: txt(b.titulo || (previo && previo.config.titulo) || campo.nombre, 120),
    };
    const datosIniciales = previo ? previo.datos : limpiarDatosPropietario({
      vendedor: { tipo: 'natural', personas: [{ trat: '', nombre: campo.propietario || '', rut: '' }], telefono: campo.telefono || '', email: campo.email || '' },
      predios: [{ tipo: campo.tipo === 'loteo' ? 'loteo' : 'agricola', rol: (campo.rol || '').split(',')[0].trim(), comuna: campo.sector || '', region: campo.region || '',
        hectareas: campo.hectareas, moneda: campo.precioUF ? 'UF' : 'CLP', precio: campo.precioUF || campo.precioCLP || null }],
    });
    campo.captacion = { token: (previo && previo.token) || crypto.randomBytes(16).toString('hex'), creado: (previo && previo.creado) || ahora(), creadoPor: (previo && previo.creadoPor) || autor,
      config, estado: (previo && previo.estado) || 'enviado', datos: datosIniciales, actualizado: ahora(), firma: null, firmaCorredor: null };
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: previo ? `Actualizó el link del propietario (comisión ${config.comision}%, vigencia ${config.vigencia} días)` : `Creó el link para el propietario (comisión ${config.comision}%, vigencia ${config.vigencia} días)` }];
    if (!previo) registrar(db, autor, `Creó el link del propietario para ${campo.nombre}`, { col: 'campos', id: campo.id });
    return campo;
  });
  if (!r) return res.status(404).json({ error: 'No se encontró el campo.' });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

router.post('/campos/:id/captacion/corredor', async (req, res) => {
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id);
    if (!campo || !campo.captacion || !campo.captacion.firma) return null;
    if (!campo.captacion.firmaCorredor) {
      campo.captacion.firmaCorredor = { nombre: autor, fecha: ahora(), ip: ipDe(req) };
      campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: 'Firmó el mandato como corredor, por Farm Brokers Chile SpA' }];
      registrar(db, autor, `Firmó como corredor el mandato de ${campo.nombre}`, { col: 'campos', id: campo.id });
    }
    return campo;
  });
  r ? res.json(r) : res.status(409).json({ error: 'El propietario aún no firma el mandato.' });
});

router.get('/campos/:id/mandato', (req, res) => {
  const campo = leer().campos.find((x) => x.id === req.params.id);
  if (!campo || !campo.captacion) return res.status(404).json({ error: 'Este campo no tiene link de propietario.' });
  const cap = campo.captacion;
  if (cap.firma) return res.json({ bloques: cap.firma.bloques, firma: { ...cap.firma, bloques: undefined, codigo: cap.firma.hash.slice(0, 12).toUpperCase() }, firmaCorredor: cap.firmaCorredor, borrador: false });
  const faltan = faltantesMandato(cap.datos);
  if (faltan.length) return res.status(409).json({ error: `Faltan datos para el mandato: ${faltan.join(', ')}.`, faltan });
  res.json({ bloques: bloquesMandato(campo), firma: null, firmaCorredor: null, borrador: true });
});

router.get('/campos/:id/archivos/:fid', (req, res) => {
  const campo = leer().campos.find((x) => x.id === req.params.id);
  const a = campo && (campo.archivos || []).find((x) => x.id === req.params.fid);
  if (!a) return res.status(404).json({ error: 'Archivo no encontrado.' });
  const ruta = path.join(ARCHIVOS, campo.id, a.id);
  if (!fs.existsSync(ruta)) return res.status(404).json({ error: 'El archivo ya no está en el servidor.' });
  res.set('Content-Type', a.mime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(a.nombre)}"`);
  fs.createReadStream(ruta).pipe(res);
});

// ───────────────────────── Plano del predio (KMZ, KML o polígonos de la tasación) ─────────────────────────
function leerZip(buf) {
  // Lector mínimo de ZIP (un KMZ es un ZIP con un archivo .kml adentro)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('El archivo KMZ está dañado.');
  const total = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const salida = [];
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10), tam = buf.readUInt32LE(p + 20);
    const lnom = buf.readUInt16LE(p + 28), lext = buf.readUInt16LE(p + 30), lcom = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const nombre = buf.slice(p + 46, p + 46 + lnom).toString('utf8');
    p += 46 + lnom + lext + lcom;
    if (!/\.kml$/i.test(nombre)) continue;
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.slice(ini, ini + tam);
    salida.push(metodo === 8 ? zlib.inflateRawSync(datos) : datos);
  }
  if (!salida.length) throw new Error('El KMZ no trae un archivo KML adentro.');
  return salida.map((b) => b.toString('utf8')).join('\n');
}
function anillosDeKML(kml) {
  const anillos = [];
  const coords = (t) => t.trim().split(/\s+/).map((c) => c.split(',').map(Number)).filter((c) => c.length >= 2 && coordOk(c[1], c[0])).map((c) => [c[0], c[1]]);
  for (const m of kml.matchAll(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)) { const a = coords(m[1]); if (a.length >= 3) anillos.push(a); }
  if (!anillos.length) for (const m of kml.matchAll(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)) { const a = coords(m[1]); if (a.length >= 3) anillos.push(a); }
  return anillos;
}
function anillosDeGeoJSON(g) {
  if (!g) return [];
  if (g.type === 'Feature') return anillosDeGeoJSON(g.geometry);
  if (g.type === 'FeatureCollection') return (g.features || []).flatMap(anillosDeGeoJSON);
  if (g.type === 'Polygon') return [g.coordinates[0]];
  if (g.type === 'MultiPolygon') return g.coordinates.map((p) => p[0]);
  return [];
}
function areaHaAnillo(a) {
  const R = 6378137, rad = Math.PI / 180; let s = 0;
  for (let i = 0; i < a.length; i++) { const [x1, y1] = a[i], [x2, y2] = a[(i + 1) % a.length]; s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad)); }
  return Math.abs((s * R * R) / 2) / 10000;
}
function armarGeo(anillos, fuente) {
  anillos = anillos.map((a) => a.filter((c) => Array.isArray(c) && coordOk(Number(c[1]), Number(c[0]))).map((c) => [Number(c[0]), Number(c[1])])).filter((a) => a.length >= 3).slice(0, 60);
  if (!anillos.length) return null;
  const reducir = (a) => { if (a.length <= 500) return a; const paso = Math.ceil(a.length / 500); return a.filter((_, i) => i % paso === 0); };
  anillos = anillos.map(reducir);
  const todos = anillos.flat();
  const bbox = [Math.min(...todos.map((c) => c[0])), Math.min(...todos.map((c) => c[1])), Math.max(...todos.map((c) => c[0])), Math.max(...todos.map((c) => c[1]))];
  const areaHa = Math.round(anillos.reduce((t, a) => t + areaHaAnillo(a), 0) * 100) / 100;
  return { fuente, anillos: anillos.map((a) => a.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6])), bbox, areaHa, centro: { lat: (bbox[1] + bbox[3]) / 2, lng: (bbox[0] + bbox[2]) / 2 }, fecha: ahora() };
}
function geoDeArchivo(buf, nombre) {
  const esZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  const kml = esZip ? leerZip(buf) : buf.toString('utf8');
  if (!/<kml|<Placemark|<coordinates/i.test(kml)) throw new Error('No parece un archivo KMZ o KML de Google Earth.');
  const g = armarGeo(anillosDeKML(kml), 'kmz');
  if (!g) throw new Error('El archivo no tiene el contorno del predio (polígonos) dibujado.');
  g.archivo = nombre;
  return g;
}
const esPlano = (a) => a.tipo === 'kmz' || /\.(kmz|kml)$/i.test(a.nombre || '');
function aplicarGeo(campo, g) {
  campo.geo = g;
  if (!campo.coordenadas) campo.coordenadas = `${g.centro.lat.toFixed(6)}, ${g.centro.lng.toFixed(6)}`;
  campo.checklist = { ...(campo.checklist || {}), plano: true };
}

// Archivos subidos por el equipo desde la ficha del campo
router.post('/campos/:id/archivo', async (req, res) => {
  const b = req.body || {};
  const tipo = TIPOS_ARCHIVO.includes(b.tipo) ? b.tipo : 'otro';
  const buf = Buffer.from(String(b.base64 || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) return res.status(400).json({ error: 'El archivo está vacío.' });
  if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera los 20 MB.' });
  const nombreArch = txt(b.nombre, 160).replace(/[\\/]/g, '_') || tipo;
  let g = null, avisoGeo = '';
  if (tipo === 'kmz' || /\.(kmz|kml)$/i.test(nombreArch)) { try { g = geoDeArchivo(buf, nombreArch); } catch (e) { avisoGeo = e.message; } }
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id); if (!campo) return null;
    const a = { id: crypto.randomBytes(8).toString('hex'), tipo: g ? 'kmz' : tipo, nombre: nombreArch, mime: txt(b.mime, 100), tamano: buf.length, fecha: ahora(), origen: 'equipo', autor };
    fs.mkdirSync(path.join(ARCHIVOS, campo.id), { recursive: true });
    fs.writeFileSync(path.join(ARCHIVOS, campo.id, a.id), buf);
    campo.archivos = [...(campo.archivos || []), a];
    const marca = { plano: 'plano', foto: 'fotos', dominio: 'dominio', hipotecas: 'hipotecas', avaluo: 'avaluo', aguas: 'aguas' }[a.tipo];
    if (marca) campo.checklist = { ...(campo.checklist || {}), [marca]: true };
    if (g) aplicarGeo(campo, g);
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: `Subió ${a.nombre}${g ? ` (plano del predio: ${g.anillos.length} ${g.anillos.length === 1 ? 'polígono' : 'polígonos'}, ${g.areaHa.toLocaleString('es-CL')} ha)` : ''}` }];
    campo.actualizado = ahora();
    return campo;
  });
  if (!r) return res.status(404).json({ error: 'No se encontró el campo.' });
  res.json({ campo: r, avisoGeo });
});

router.delete('/campos/:id/archivos/:fid', async (req, res) => {
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id); if (!campo) return null;
    const a = (campo.archivos || []).find((x) => x.id === req.params.fid); if (!a) return null;
    campo.archivos = campo.archivos.filter((x) => x.id !== a.id);
    try { fs.unlinkSync(path.join(ARCHIVOS, campo.id, a.id)); } catch (e) {}
    if (campo.geo && campo.geo.fuente === 'kmz' && campo.geo.archivo === a.nombre) delete campo.geo;
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: `Eliminó el archivo ${a.nombre}` }];
    return campo;
  });
  r ? res.json(r) : res.status(404).json({ error: 'No se encontró el archivo.' });
});

// ───────────────────────── Redactar la descripción para el cliente (IA) ─────────────────────────
async function llamarClaude(prompt) {
  if (global.__claudeMock) return global.__claudeMock(prompt);
  const clave = process.env.ANTHROPIC_API_KEY;
  if (!clave) throw new Error('Falta la variable ANTHROPIC_API_KEY en Railway.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1400, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `El servicio de IA respondió ${r.status}.`);
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
function antecedentesCampo(c) {
  const w = c.web || {}, d = w.detalle || {}, ti = c.tasacionInfo || {}, cap = c.captacion && c.captacion.datos;
  const filas = [
    ['Nombre', c.nombre], ['Tipo de propiedad', (todosLosTipos()[c.tipo] || c.tipo)], ['Comuna o sector', c.sector], ['Región', c.region],
    ['Superficie', d.superficie || (c.hectareas ? `${c.hectareas} ha` : '')], ['Superficie según plano', c.geo ? `${c.geo.areaHa} ha` : ''],
    ['Derechos de agua', d.agua || c.agua], ['Fuente del agua', c.fuenteAgua], ['Plantaciones', d.plantaciones || c.plantaciones], ['Aptitud', c.aptitud],
    ['Infraestructura', c.infraestructura || (cap && cap.infraestructura)], ['Acceso', c.acceso || ti.acceso],
    ['Distancia a Santiago', ti.distSantiago], ['Distancia a la comuna', ti.distComuna], ['Altitud', ti.altitud],
    ['Suelos (tasación)', ti.suelos], ['Clima (tasación)', ti.clima], ['Recursos hídricos (tasación)', ti.aguas], ['Escasez hídrica', ti.escasez],
    ['Construcciones (tasación)', ti.construcciones], ['Instalaciones (tasación)', ti.instalaciones], ['Usos de suelo (tasación)', ti.usos],
    ['Plantaciones (tasación)', ti.plantaciones], ['Conclusión de la tasación', ti.conclusion],
    ['Deslindes y accesos (propietario)', cap ? cap.predios.map((p) => p.descripcion).filter(Boolean).join('; ') : ''],
    ['Loteo', cap ? cap.predios.filter((p) => p.tipo === 'loteo' && p.lotes).map((p) => `${p.lotes} lotes${p.m2Lote ? ` de ${p.m2Lote} m²` : ''}${p.planoSAG ? ', plano SAG aprobado' : ''}`).join('; ') : ''],
  ].filter(([, v]) => v && String(v).trim());
  const web = w.descripcion && w.descripcion.length ? w.descripcion.join('\n') : '';
  return { filas, web };
}
router.post('/campos/:id/redactar', async (req, res) => {
  const db = leer();
  const base = db.campos.find((x) => x.id === req.params.id);
  if (!base) return res.status(404).json({ error: 'No se encontró el campo.' });
  // Usa también lo que el usuario tenga escrito sin guardar
  const campo = { ...base, ...limpiar('campos', { ...base, ...((req.body || {}).campo || {}) }), web: base.web, geo: base.geo, captacion: base.captacion, tasacionInfo: base.tasacionInfo };
  const { filas, web } = antecedentesCampo(campo);
  if (filas.length < 4 && !web) return res.status(400).json({ error: 'Hay muy pocos datos del campo para redactar. Completa superficie, agua, plantaciones o aptitud, o vincula la publicación o la tasación.' });
  const prompt = `Eres redactor comercial de Farm Brokers Chile, corredora de campos agrícolas. Escribe la descripción de este campo para la ficha que se entrega a un posible comprador.

Reglas:
- Usa SOLO los antecedentes de abajo. No inventes cifras, distancias, cultivos, calidades ni ventajas que no estén escritas. Si un dato no está, no lo menciones.
- Español de Chile, tono profesional y cercano, sin exageraciones ni signos de exclamación.
- No incluyas precio, comisión, nombres de propietarios, RUT, rol SII ni datos de contacto.
- Formato: un párrafo inicial de 2 o 3 oraciones que presente el campo. Luego párrafos breves que empiecen con una etiqueta y dos puntos, en este orden y solo si hay datos: "Superficie:", "Suelos:", "Aguas:", "Plantaciones:", "Clima:", "Infraestructura:", "Acceso:". Puedes agregar "Potencial:" solo si los antecedentes mencionan aptitud o conclusión.
- Si hay una lista de elementos (por ejemplo varios derechos de agua), escríbelos en líneas que empiecen con "- ".
- Entre 120 y 280 palabras. Devuelve solo el texto, sin títulos ni comentarios.

Antecedentes del campo:
${filas.map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n')}
${web ? `\nDescripción publicada en farmbrokers.cl (úsala como base de estilo y datos):\n${web.slice(0, 4000)}` : ''}`;
  try {
    const texto = (await llamarClaude(prompt)).replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/\n{2,}/g, '\n').trim();
    const autor = usuarioDe(req);
    await modificar((d2) => { registrar(d2, autor, `Redactó con IA la descripción de ${campo.nombre}`, { col: 'campos', id: campo.id }); });
    res.json({ texto });
  } catch (e) { res.status(502).json({ error: `No se pudo redactar: ${e.message}` }); }
});

// ───────────────────────── Carga masiva de KMZ ─────────────────────────
function nombreKML(buf) {
  try { const esZip = buf.readUInt32LE(0) === 0x04034b50; const kml = esZip ? leerZip(buf) : buf.toString('utf8'); const m = kml.match(/<name>\s*(?:<!\[CDATA\[)?([^<\]]{2,120})/i); return m ? entidades(m[1]).trim() : ''; }
  catch (e) { return ''; }
}
const distKm = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r; const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
function coordsCampo(c) {
  const m = String(c.coordenadas || '').match(/(-\d{1,2}\.\d+)\s*,\s*(-\d{1,3}\.\d+)/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  if (c.web && c.web.coordenadas && c.web.fuenteUbicacion !== 'comuna') return c.web.coordenadas;
  return null;
}
function sugerirCampo(campos, nombreArchivo, nombreInterno, g) {
  const texto = norm(`${nombreArchivo} ${nombreInterno}`).replace(/[_.-]+/g, ' ');
  const textoSinEsp = texto.replace(/\s+/g, '');
  const porCodigo = campos.find((c) => c.codigo && c.codigo.length >= 5 && textoSinEsp.includes(norm(c.codigo).replace(/\s+/g, '')));
  if (porCodigo) return { campoId: porCodigo.id, motivo: `ID ${porCodigo.codigo} en el nombre` };
  const porNombre = campos.filter((c) => norm(c.nombre).length >= 4 && texto.includes(norm(c.nombre).replace(/[_.-]+/g, ' ')))
    .sort((a, b) => b.nombre.length - a.nombre.length)[0];
  if (porNombre) return { campoId: porNombre.id, motivo: `nombre "${porNombre.nombre}"` };
  if (g) {
    const cerca = campos.map((c) => ({ c, p: coordsCampo(c) })).filter((x) => x.p).map((x) => ({ ...x, d: distKm(x.p, g.centro) })).sort((a, b) => a.d - b.d)[0];
    if (cerca && cerca.d <= 4) return { campoId: cerca.c.id, motivo: `ubicación a ${cerca.d < 1 ? 'menos de 1' : Math.round(cerca.d)} km` };
    const sector = campos.find((c) => norm(c.sector).length >= 4 && texto.includes(norm(c.sector)));
    if (sector) return { campoId: sector.id, motivo: `comuna ${sector.sector} en el nombre (revisar)`, dudoso: true };
  }
  return null;
}
router.post('/kmz/analizar', (req, res) => {
  const lista = Array.isArray((req.body || {}).archivos) ? req.body.archivos.slice(0, 30) : [];
  const campos = leer().campos.filter((c) => c.etapa !== 'Descartado');
  res.json({ resultados: lista.map((a) => {
    const nombre = txt(a.nombre, 160);
    try {
      const buf = Buffer.from(String(a.base64 || '').replace(/^data:[^,]*,/, ''), 'base64');
      const g = geoDeArchivo(buf, nombre);
      const interno = nombreKML(buf);
      return { nombre, ok: true, areaHa: g.areaHa, poligonos: g.anillos.length, nombreInterno: interno, centro: g.centro, sugerencia: sugerirCampo(campos, nombre, interno, g) };
    } catch (e) { return { nombre, ok: false, error: e.message }; }
  }) });
});

// ───────────────────────── Plano con acuerdo de confidencialidad ─────────────────────────
const ACUERDO_BASE = `ACUERDO DE CONFIDENCIALIDAD

Quien suscribe, en adelante "el Interesado", declara recibir de FARM BROKERS CHILE SPA, rol único tributario N° 77.089.307-0, en adelante "el Corredor", información sobre la propiedad {CAMPO}, en adelante "la Propiedad", incluyendo su plano, su ubicación exacta y el archivo KMZ, con el solo fin de evaluar su eventual compra.

1. El Interesado se obliga a mantener la más estricta confidencialidad respecto de la información recibida, y a no divulgarla, copiarla ni entregarla a terceros sin autorización previa, expresa y por escrito del Corredor, salvo a sus asesores directos, quienes quedarán sujetos a la misma obligación.

2. El Interesado se obliga a no contactar directamente al propietario de la Propiedad ni a terceros relacionados con ella para negociar su compra, y a canalizar toda gestión a través del Corredor.

3. Si el Interesado, o una persona o sociedad relacionada con él, adquiere la Propiedad dentro de los 24 meses siguientes a la fecha de este acuerdo, reconoce que la conoció por intermedio del Corredor, quien tendrá derecho a la comisión correspondiente.

4. La información se entrega de manera referencial y deberá ser verificada por el Interesado.

El Interesado acepta este acuerdo en forma electrónica, con los datos y la fecha que se registran al momento de su aceptación.`;
const textoAcuerdo = (db) => (db.config && db.config.acuerdo) || ACUERDO_BASE;
const acuerdoPara = (db, campo) => textoAcuerdo(db).replace(/\{CAMPO\}/g, (campo.web && campo.web.titulo) || campo.nombre);

router.put('/config/acuerdo', async (req, res) => {
  const t = txt((req.body || {}).texto, 20000);
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    db.config = { ...(db.config || {}), acuerdo: t && t !== ACUERDO_BASE ? t : '' };
    registrar(db, autor, t ? 'Actualizó el texto del acuerdo de confidencialidad' : 'Restauró el texto base del acuerdo de confidencialidad', null);
    return { acuerdo: textoAcuerdo(db) };
  });
  res.json(r);
});

router.post('/campos/:id/compartir', async (req, res) => {
  const b = req.body || {};
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id); if (!campo) return null;
    if (!campo.geo) return { error: 'Este campo no tiene plano. Sube primero su KMZ.' };
    const cli = b.clienteId ? db.clientes.find((x) => x.id === b.clienteId) : null;
    const dias = Math.max(1, Math.min(365, Math.round(Number(b.dias) || 15)));
    const c = {
      token: crypto.randomBytes(16).toString('hex'), clienteId: cli ? cli.id : '', destinatario: txt(b.nombre, 160) || (cli ? cli.nombre : ''),
      email: txt(b.email, 160) || (cli ? emailsCli(cli)[0] || '' : ''), telefono: txt(b.telefono, 40) || (cli ? cli.telefono : ''),
      creado: ahora(), creadoPor: autor, vence: new Date(Date.now() + dias * 864e5).toISOString(), descarga: b.descarga !== false, activo: true,
      aceptacion: null, descargas: [], vistas: 0,
    };
    if (!c.destinatario) return { error: 'Indica a quién le envías el plano.' };
    campo.compartidos = [...(campo.compartidos || []), c];
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: `Creó un link de plano con confidencialidad para ${c.destinatario} (vence en ${dias} días)` }];
    if (cli) cli.historial = [...(cli.historial || []), { fecha: ahora(), autor, texto: `Se le preparó el plano de ${campo.nombre} con acuerdo de confidencialidad` }];
    registrar(db, autor, `Preparó el plano de ${campo.nombre} para ${c.destinatario}`, { col: 'campos', id: campo.id });
    return campo;
  });
  if (!r) return res.status(404).json({ error: 'No se encontró el campo.' });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
const emailsCli = (c) => String(c.email || '').match(/[^\s,;<>]+@[^\s,;<>]+\.[a-z]{2,}/gi) || [];

router.post('/campos/:id/compartir/:token/desactivar', async (req, res) => {
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const campo = db.campos.find((x) => x.id === req.params.id); if (!campo) return null;
    const c = (campo.compartidos || []).find((x) => x.token === req.params.token); if (!c) return null;
    c.activo = false;
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: `Desactivó el link de plano de ${c.destinatario}` }];
    return campo;
  });
  r ? res.json(r) : res.status(404).json({ error: 'No se encontró el link.' });
});

function buscarCompartido(db, token) {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  for (const campo of db.campos) { const c = (campo.compartidos || []).find((x) => x.token === token); if (c) return { campo, c }; }
  return null;
}
function publicoPlano(db, campo, c) {
  const vencido = Date.now() > new Date(c.vence).getTime();
  const disponible = c.activo && !vencido && !!campo.geo;
  const texto = acuerdoPara(db, campo);
  return {
    titulo: (campo.web && campo.web.titulo) || campo.nombre, lugar: [campo.sector, REGION_TEXTO[campo.region]].filter(Boolean).join(', '),
    destinatario: c.destinatario, vence: c.vence, disponible, motivo: !c.activo ? 'Este link fue desactivado por Farm Brokers.' : vencido ? 'Este link venció.' : !campo.geo ? 'El plano ya no está disponible.' : '',
    acuerdo: texto, hash: hashBloques([texto, campo.id]), descarga: c.descarga,
    aceptacion: c.aceptacion ? { nombre: c.aceptacion.nombre, rut: c.aceptacion.rut, fecha: c.aceptacion.fecha, codigo: c.aceptacion.hash.slice(0, 12).toUpperCase() } : null,
    plano: c.aceptacion && disponible ? { anillos: campo.geo.anillos, bbox: campo.geo.bbox, areaHa: campo.geo.areaHa, centro: campo.geo.centro } : null,
  };
}
router.get('/publico-plano/:token', async (req, res) => {
  const r = await modificar((db) => { const x = buscarCompartido(db, req.params.token); if (!x) return null; x.c.vistas = (x.c.vistas || 0) + 1; return publicoPlano(db, x.campo, x.c); });
  r ? res.json(r) : res.status(404).json({ error: 'Este link no es válido. Pide uno nuevo a Farm Brokers.' });
});
router.post('/publico-plano/:token/aceptar', async (req, res) => {
  const b = req.body || {};
  const r = await modificar((db) => {
    const x = buscarCompartido(db, req.params.token); if (!x) return null;
    const { campo, c } = x;
    const pub = publicoPlano(db, campo, c);
    if (!pub.disponible) return { error: pub.motivo };
    if (c.aceptacion) return pub;
    if (b.hash !== pub.hash) return { error: 'El texto del acuerdo cambió. Recarga la página y vuelve a leerlo.' };
    if (b.acepto !== true) return { error: 'Debes marcar que aceptas el acuerdo.' };
    const nombre = txt(b.nombre, 160), rut = txt(b.rut, 20), email = txt(b.email, 160);
    if (nombre.length < 3) return { error: 'Escribe tu nombre completo.' };
    if (!rutValido(rut)) return { error: 'El RUT no es válido.' };
    c.aceptacion = { nombre, rut: rutFormato(rut), email, fecha: ahora(), ip: ipDe(req), agente: txt(req.get('user-agent'), 300), hash: pub.hash, texto: pub.acuerdo };
    const quien = `${nombre} (cliente)`;
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor: quien, texto: `Aceptó el acuerdo de confidencialidad y accedió al plano (RUT ${c.aceptacion.rut}, código ${pub.hash.slice(0, 12).toUpperCase()})` }];
    const cli = c.clienteId && db.clientes.find((y) => y.id === c.clienteId);
    if (cli) cli.historial = [...(cli.historial || []), { fecha: ahora(), autor: quien, texto: `Aceptó la confidencialidad y vio el plano de ${campo.nombre}` }];
    registrar(db, quien, `Aceptó la confidencialidad del plano de ${campo.nombre}`, { col: 'campos', id: campo.id });
    return publicoPlano(db, campo, c);
  });
  if (!r) return res.status(404).json({ error: 'Este link no es válido.' });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

// KMZ personalizado: lleva grabado a quién se entregó
const TABLA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipUno(nombre, datos) {
  const n = Buffer.from(nombre), comp = zlib.deflateRawSync(datos), crc = crc32(datos);
  const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(datos.length, 22); loc.writeUInt16LE(n.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(datos.length, 24); cen.writeUInt16LE(n.length, 28);
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(1, 8); fin.writeUInt16LE(1, 10); fin.writeUInt32LE(46 + n.length, 12); fin.writeUInt32LE(30 + n.length + comp.length, 16);
  return Buffer.concat([loc, n, comp, cen, n, fin]);
}
const escXml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function kmlPersonalizado(campo, c) {
  const a = c.aceptacion, titulo = (campo.web && campo.web.titulo) || campo.nombre;
  const marca = `CONFIDENCIAL. Entregado por Farm Brokers Chile a ${a.nombre}, RUT ${a.rut}, el ${a.fecha.slice(0, 10)}. Uso sujeto al acuerdo de confidencialidad aceptado (código ${a.hash.slice(0, 12).toUpperCase()}). Prohibida su difusión.`;
  let kml = '';
  const archivo = campo.geo.archivo && (campo.archivos || []).find((x) => x.nombre === campo.geo.archivo);
  if (archivo) { try { const buf = fs.readFileSync(path.join(ARCHIVOS, campo.id, archivo.id)); kml = buf.readUInt32LE(0) === 0x04034b50 ? leerZip(buf) : buf.toString('utf8'); } catch (e) { kml = ''; } }
  if (kml && /<Document[^>]*>/i.test(kml)) return kml.replace(/<Document([^>]*)>/i, `<Document$1><description>${escXml(marca)}</description>`);
  const pol = campo.geo.anillos.map((r) => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${r.map(([x, y]) => `${x},${y},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escXml(titulo)} (confidencial)</name><description>${escXml(marca)}</description>`
    + `<Style id="predio"><LineStyle><color>ff5ad6ff</color><width>3</width></LineStyle><PolyStyle><color>335ad6ff</color></PolyStyle></Style>`
    + `<Placemark><name>${escXml(titulo)}</name><description>${escXml(marca)}</description><styleUrl>#predio</styleUrl><MultiGeometry>${pol}</MultiGeometry></Placemark></Document></kml>`;
}
router.get('/publico-plano/:token/kmz', async (req, res) => {
  const r = await modificar((db) => {
    const x = buscarCompartido(db, req.params.token); if (!x) return null;
    const { campo, c } = x, pub = publicoPlano(db, campo, c);
    if (!pub.disponible || !c.aceptacion) return { error: pub.motivo || 'Primero debes aceptar el acuerdo de confidencialidad.' };
    if (!c.descarga) return { error: 'Este plano se puede ver en línea, pero no descargar.' };
    c.descargas = [...(c.descargas || []), { fecha: ahora(), ip: ipDe(req) }];
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor: `${c.aceptacion.nombre} (cliente)`, texto: 'Descargó el KMZ personalizado del plano' }];
    registrar(db, `${c.aceptacion.nombre} (cliente)`, `Descargó el KMZ de ${campo.nombre}`, { col: 'campos', id: campo.id });
    return { kml: kmlPersonalizado(campo, c), nombre: `${norm(pub.titulo).replace(/[^a-z0-9]+/g, '-')}-confidencial.kmz` };
  });
  if (!r) return res.status(404).json({ error: 'Este link no es válido.' });
  if (r.error) return res.status(409).json(r);
  res.set('Content-Type', 'application/vnd.google-earth.kmz');
  res.set('Content-Disposition', `attachment; filename="${r.nombre}"`);
  res.send(zipUno('doc.kml', Buffer.from(r.kml, 'utf8')));
});

// ───────────────────────── Imágenes para el PDF (fotos de la web y mapas) ─────────────────────────
// El navegador solo puede copiar imágenes de otros sitios al PDF si llegan con permiso (CORS); este puente las entrega así.
const HOSTS_IMG = [/(^|\.)farmbrokers\.cl$/, /^server\.arcgisonline\.com$/, /^([abc]\.)?tile\.openstreetmap\.org$/];
function descargarBinario(url, redirecciones = 3) {
  return new Promise((ok, mal) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FarmBrokersCRM/1.0 (+https://farmbrokers.cl)' }, timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirecciones > 0) { res.resume(); return ok(descargarBinario(new URL(res.headers.location, url).toString(), redirecciones - 1)); }
      if (res.statusCode !== 200) { res.resume(); return mal(new Error(`respondió ${res.statusCode}`)); }
      const partes = []; let total = 0;
      res.on('data', (c) => { total += c.length; if (total > 12 * 1024 * 1024) req.destroy(new Error('imagen demasiado grande')); else partes.push(c); });
      res.on('end', () => ok({ buf: Buffer.concat(partes), tipo: res.headers['content-type'] || 'image/jpeg' }));
    });
    req.on('timeout', () => req.destroy(new Error('tiempo agotado')));
    req.on('error', mal);
  });
}
let traerBinario = descargarBinario;
const cacheImg = new Map(); let pesoCache = 0;
router.get('/publico-img', async (req, res) => {
  let u;
  try { u = new URL(String(req.query.u || '')); } catch (e) { return res.status(400).end(); }
  if (u.protocol !== 'https:' || !HOSTS_IMG.some((r) => r.test(u.hostname))) return res.status(403).end();
  const clave = u.toString();
  let item = cacheImg.get(clave);
  if (!item || Date.now() - item.t > 24 * 3600 * 1000) {
    try { const r = await traerBinario(clave); if (!/^image\//.test(r.tipo)) return res.status(415).end(); item = { ...r, t: Date.now() }; }
    catch (e) { return res.status(502).end(); }
    cacheImg.set(clave, item); pesoCache += item.buf.length;
    while (pesoCache > 80 * 1024 * 1024 && cacheImg.size) { const [k, v] = cacheImg.entries().next().value; cacheImg.delete(k); pesoCache -= v.buf.length; }
  }
  res.set('Content-Type', item.tipo);
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(item.buf);
});

// ── Propietario (sin clave del equipo, solo con el link)
router.get('/publico/:token', (req, res) => {
  const campo = buscarPorToken(leer(), req.params.token);
  if (!campo) return res.status(404).json({ error: 'Este link no es válido o fue reemplazado. Pide uno nuevo a Farm Brokers.' });
  res.json(publicoDe(campo));
});

router.post('/publico/:token/datos', async (req, res) => {
  const enviar = !!(req.body || {}).enviar;
  const r = await modificar((db) => {
    const campo = buscarPorToken(db, req.params.token);
    if (!campo) return null;
    const cap = campo.captacion;
    if (cap.firma) return { error: 'El mandato ya fue firmado. Si necesitas corregir algo, contacta a Farm Brokers.' };
    cap.datos = limpiarDatosPropietario((req.body || {}).datos, cap.datos);
    cap.actualizado = ahora();
    if (cap.estado === 'enviado') cap.estado = 'en_progreso';
    volcarAlCampo(campo, cap.datos);
    const quien = `${nombreVendedor(cap.datos) || 'Propietario'} (propietario)`;
    if (enviar) {
      const faltan = faltantesMandato(cap.datos);
      if (cap.datos.sinPrecio) {
        cap.estado = 'tasacion';
        if (!db.tasaciones.some((t) => t.campoId === campo.id)) {
          const p = cap.datos.predios[0];
          db.tasaciones.push({ id: id(), ...limpiar('tasaciones', { titulo: `Tasación ${campo.nombre}`, cliente: nombreVendedor(cap.datos), telefono: cap.datos.vendedor.telefono,
            email: cap.datos.vendedor.email, campoId: campo.id, rol: cap.datos.predios.map((x) => x.rol).filter(Boolean).join(', '), comuna: p.comuna, etapa: 'Solicitud',
            proximaAccion: 'Contactar al propietario para cotizar la tasación', proximaFecha: new Date().toLocaleDateString('en-CA') }),
            historial: [{ fecha: ahora(), autor: quien, texto: 'Solicitada desde el formulario del propietario. Oferta: el costo de la tasación se devuelve si el campo se vende con Farm Brokers.' }],
            envios: [], creado: ahora(), actualizado: ahora() });
        }
        registrar(db, quien, `Completó los datos de ${campo.nombre} y pidió tasación`, { col: 'campos', id: campo.id });
      } else if (!faltan.length) {
        cap.estado = 'completado';
        registrar(db, quien, `Completó los datos de ${campo.nombre}. El mandato está listo para firmar`, { col: 'campos', id: campo.id });
      }
      campo.historial = [...(campo.historial || []), { fecha: ahora(), autor: quien, texto: cap.estado === 'tasacion' ? 'Completó el formulario y pidió tasación' : 'Completó el formulario del propietario' }];
    }
    campo.actualizado = ahora();
    return publicoDe(campo);
  });
  if (!r) return res.status(404).json({ error: 'Este link no es válido.' });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

router.post('/publico/:token/archivo', async (req, res) => {
  const b = req.body || {};
  const tipo = TIPOS_ARCHIVO.includes(b.tipo) ? b.tipo : 'otro';
  const datos = String(b.base64 || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(datos, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'El archivo está vacío.' });
  if (buf.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera los 15 MB. Envíalo más liviano o por correo a contacto@farmbrokers.cl.' });
  const r = await modificar((db) => {
    const campo = buscarPorToken(db, req.params.token);
    if (!campo) return null;
    if ((campo.archivos || []).filter((a) => a.origen === 'propietario').length >= 40) return { error: 'Se alcanzó el máximo de 40 archivos.' };
    const a = { id: crypto.randomBytes(8).toString('hex'), tipo, nombre: txt(b.nombre, 160).replace(/[\\/]/g, '_') || `${tipo}`, mime: txt(b.mime, 100), tamano: buf.length, fecha: ahora(), origen: 'propietario' };
    fs.mkdirSync(path.join(ARCHIVOS, campo.id), { recursive: true });
    fs.writeFileSync(path.join(ARCHIVOS, campo.id, a.id), buf);
    campo.archivos = [...(campo.archivos || []), a];
    const marca = { kmz: 'plano', plano: 'plano', foto: 'fotos', dominio: 'dominio', hipotecas: 'hipotecas', avaluo: 'avaluo', aguas: 'aguas' }[tipo];
    if (marca) campo.checklist = { ...(campo.checklist || {}), [marca]: true };
    if (tipo === 'kmz' || /\.(kmz|kml)$/i.test(a.nombre)) { try { aplicarGeo(campo, geoDeArchivo(buf, a.nombre)); } catch (e) { /* plano en PDF u otro formato */ } }
    return { ok: true, archivo: { id: a.id, tipo: a.tipo, nombre: a.nombre, tamano: a.tamano, fecha: a.fecha } };
  });
  if (!r) return res.status(404).json({ error: 'Este link no es válido.' });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

router.delete('/publico/:token/archivo/:fid', async (req, res) => {
  const r = await modificar((db) => {
    const campo = buscarPorToken(db, req.params.token);
    if (!campo) return null;
    if (campo.captacion.firma) return { error: 'El mandato ya fue firmado.' };
    const a = (campo.archivos || []).find((x) => x.id === req.params.fid && x.origen === 'propietario');
    if (!a) return { error: 'Archivo no encontrado.' };
    campo.archivos = campo.archivos.filter((x) => x.id !== a.id);
    try { fs.unlinkSync(path.join(ARCHIVOS, campo.id, a.id)); } catch (e) {}
    return { ok: true };
  });
  if (!r) return res.status(404).json({ error: 'Este link no es válido.' });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

router.get('/publico/:token/mandato', (req, res) => {
  const campo = buscarPorToken(leer(), req.params.token);
  if (!campo) return res.status(404).json({ error: 'Este link no es válido.' });
  const cap = campo.captacion;
  if (cap.firma) return res.json({ bloques: cap.firma.bloques, hash: cap.firma.hash, firma: publicoDe(campo).firma, firmaCorredor: cap.firmaCorredor ? { nombre: cap.firmaCorredor.nombre, fecha: cap.firmaCorredor.fecha } : null });
  const faltan = faltantesMandato(cap.datos);
  if (faltan.length) return res.status(409).json({ error: 'Faltan datos para preparar el mandato.', faltan });
  const bloques = bloquesMandato(campo);
  res.json({ bloques, hash: hashBloques(bloques), firma: null });
});

router.post('/publico/:token/firmar', async (req, res) => {
  const b = req.body || {};
  const r = await modificar((db) => {
    const campo = buscarPorToken(db, req.params.token);
    if (!campo) return null;
    const cap = campo.captacion;
    if (cap.firma) return { error: 'Este mandato ya fue firmado.' };
    const faltan = faltantesMandato(cap.datos);
    if (faltan.length) return { error: `Faltan datos: ${faltan.join(', ')}.` };
    const bloques = bloquesMandato(campo);
    const hash = hashBloques(bloques);
    if (b.hash !== hash) return { error: 'El texto del mandato cambió mientras lo revisabas. Vuelve a abrir la revisión y confirma de nuevo.', recargar: true };
    if (b.acepto !== true) return { error: 'Debes marcar que leíste y aceptas el mandato.' };
    const nombre = txt(b.nombre, 160), rut = txt(b.rut, 20);
    if (!nombre) return { error: 'Escribe tu nombre completo para firmar.' };
    if (!rutValido(rut)) return { error: 'El RUT no es válido. Revísalo e intenta de nuevo.' };
    const firmantes = cap.datos.vendedor.tipo === 'empresa' ? [cap.datos.vendedor.empresa.repRut] : cap.datos.vendedor.personas.map((p) => p.rut);
    if (!firmantes.some((x) => rutLimpio(x) === rutLimpio(rut))) return { error: 'El RUT no coincide con el del vendedor indicado en el mandato.' };
    cap.firma = { nombre, rut: rutFormato(rut), fecha: ahora(), ip: ipDe(req), agente: txt(req.get('user-agent'), 300), hash, bloques };
    cap.estado = 'firmado';
    campo.checklist = { ...(campo.checklist || {}), mandato: true };
    const quien = `${nombre} (propietario)`;
    const previa = campo.etapa;
    if (['Prospección', 'Captación', 'Documentación'].includes(campo.etapa)) campo.etapa = 'Mandato firmado';
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor: quien, texto: `Firmó el mandato de venta electrónicamente (código ${hash.slice(0, 12).toUpperCase()})` }];
    if (previa !== campo.etapa) campo.historial.push({ fecha: ahora(), autor: 'Sistema', texto: `Etapa: ${previa} → ${campo.etapa}` });
    campo.proximaAccion = campo.proximaAccion || 'Revisar antecedentes y publicar el campo';
    campo.proximaFecha = campo.proximaFecha || new Date().toLocaleDateString('en-CA');
    campo.actualizado = ahora();
    registrar(db, quien, `Firmó el mandato de ${campo.nombre}`, { col: 'campos', id: campo.id });
    return publicoDe(campo);
  });
  if (!r) return res.status(404).json({ error: 'Este link no es válido.' });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

// ───────────────────────── Datos desde farmbrokers.cl (fotos, ficha y ubicación) ─────────────────────────
function descargarTexto(url, redirecciones = 3) {
  return new Promise((ok, mal) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FarmBrokersCRM/1.0 (+https://farmbrokers.cl)', Accept: 'text/html,application/json' }, timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirecciones > 0) {
        res.resume(); return ok(descargarTexto(new URL(res.headers.location, url).toString(), redirecciones - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return mal(new Error(`La página respondió ${res.statusCode}.`)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; if (d.length > 6e6) req.destroy(); }); res.on('end', () => ok(d));
    });
    req.on('timeout', () => req.destroy(new Error('La página tardó demasiado en responder.')));
    req.on('error', mal);
  });
}
const esFarmBrokers = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /^(www\.)?farmbrokers\.cl$/.test(x.hostname) && x.pathname.startsWith('/propiedad/'); } catch (e) { return false; } };
const ENT = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', ordm: 'º', ordf: 'ª', deg: '°', sup2: '²', sup3: '³', laquo: '«', raquo: '»', hellip: '…', iexcl: '¡', iquest: '¿', middot: '·', bull: '•' };
const entidades = (t) => t.replace(/&([A-Za-z]+\d?);/g, (m, k) => (ENT[k] !== undefined ? ENT[k] : m)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
  .replace(/&ndash;|&#8211;/g, '–').replace(/&mdash;|&#8212;/g, '—').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
function aLineas(html) {
  return entidades(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ').replace(/<(br|\/p|\/li|\/div|\/h[1-6]|\/tr|\/ul|\/ol|\/section|\/article)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const coordOk = (lat, lng) => lat < -17 && lat > -56.5 && lng < -66 && lng > -110;
function buscarCoordenadas(html) {
  const pruebas = [
    /"lat(?:itude)?"\s*:\s*"?(-\d{1,2}\.\d{3,})"?\s*,\s*"(?:lng|long|longitude)"\s*:\s*"?(-\d{1,3}\.\d{3,})/i,
    /data-lat(?:itude)?="(-\d{1,2}\.\d{3,})"[^>]*?data-(?:lng|long|longitude)="(-\d{1,3}\.\d{3,})"/i,
    /fave_property_location[^0-9-]{0,40}(-\d{1,2}\.\d{3,})\s*,\s*(-\d{1,3}\.\d{3,})/i,
    /maps\.google\.[a-z.]+\/[^"'\s]*?[?&@=](-\d{1,2}\.\d{3,})\s*,\s*(-\d{1,3}\.\d{3,})/i,
    /google\.[a-z.]+\/maps[^"'\s]*?@(-\d{1,2}\.\d{3,}),(-\d{1,3}\.\d{3,})/i,
  ];
  for (const r of pruebas) { const m = html.match(r); if (m && coordOk(Number(m[1]), Number(m[2]))) return { lat: Number(m[1]), lng: Number(m[2]) }; }
  return null;
}
function analizarPropiedad(html, url) {
  const meta = (p) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i')); return m ? entidades(m[1]).trim() : ''; };
  const lineasV = aLineas(html); // con viñetas, solo para la descripción
  const lineas = lineasV.map((l) => l.replace(/^•\s*/, ''));
  const idx = (re, desde = 0) => { for (let i = desde; i < lineas.length; i++) if (re.test(lineas[i])) return i; return -1; };
  // Galería: imágenes de la parte superior (antes de "Vista General" o de la descripción)
  const iniG = Math.max(0, html.search(/pills-gallery|property-banner|top-gallery|<h1/i));
  let finG = html.search(/Vista General|property-overview-wrap|property-description-wrap/i); if (finG <= iniG) finG = Math.min(html.length, iniG + 60000);
  const reImg = /https?:\/\/(?:www\.)?farmbrokers\.cl\/wp-content\/uploads\/(20\d\d)\/(\d\d)\/[^"'\s)<>]+?\.(?:jpe?g|png|webp)/gi;
  const fotos = []; const vistas = new Set();
  for (const m of html.slice(iniG, finG).matchAll(reImg)) {
    if (m[1] === '2023' && m[2] === '07') continue; // íconos y logos del sitio
    const completa = m[0].replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, '').replace(/^http:/, 'https:');
    if (!vistas.has(completa)) { vistas.add(completa); fotos.push(completa); }
  }
  const og = meta('og:image'); if (og && !vistas.has(og)) fotos.unshift(og);
  // Detalles (pares etiqueta-valor)
  const detalle = {};
  const iniD = idx(/^Detalles$/i); const desdeD = iniD >= 0 ? iniD : 0;
  const claves = { 'ID de propiedad': 'id', Precio: 'precio', 'Tamaño de propiedad': 'superficie', 'Tipo de Propiedad': 'tipo', 'Estado de la propiedad': 'estado', Agua: 'agua', Plantaciones: 'plantaciones' };
  for (let i = desdeD; i < Math.min(lineas.length, desdeD + 60); i++) {
    for (const [etq, k] of Object.entries(claves)) {
      if (detalle[k]) continue;
      const m = lineas[i].match(new RegExp(`^${etq}\\s*:?\\s*(.*)$`, 'i'));
      if (m) detalle[k] = m[1] || (lineas[i + 1] && !Object.keys(claves).some((c) => lineas[i + 1].startsWith(c)) ? lineas[i + 1] : '');
    }
    if (/^Información de contacto|^Anuncios Similares/i.test(lineas[i])) break;
  }
  if (!detalle.id) { const m = lineas.join('\n').match(/ID de propiedad:?\s*([A-Z0-9]{5,})/i); if (m) detalle.id = m[1]; }
  // Descripción
  const iD = idx(/^Descripci[oó]n\b.{0,20}$/i), fD = iD >= 0 ? idx(/^(Dirección|Detalles|Características|Información de contacto|Video|Mapa|Galería)\b/i, iD + 1) : -1;
  let parrafos = iD >= 0 ? lineasV.slice(iD + 1, fD > iD ? fD : iD + 40).filter((l) => !/^(Read More|Leer más|Ver más|Mostrar más)$/i.test(l)) : [];
  if (!parrafos.length) {
    // Alternativa: el bloque de descripción del tema, aunque no tenga título
    const m = html.match(/property-description-wrap[\s\S]*?(?=<[^>]*property-(?:address|detail|features|video|map|floor|walkscore|contact)[\w-]*|<footer)/i);
    if (m) parrafos = aLineas(m[0].replace(/^[^>]*>/, '').replace(/<[^>]*$/, '')).filter((l) => !/^(Descripci[oó]n|Read More|Leer más|Ver más)$/i.test(l));
  }
  parrafos = parrafos.filter((l) => !/<\/?[a-z][^>]*$|^<|class=["']|id=["']/i.test(l)).map((l) => l.replace(/<[^>]*>?/g, '').trim()).filter(Boolean);
  const resumenMeta = meta('og:description') || meta('description');
  if (!parrafos.length && resumenMeta) parrafos = [resumenMeta];
  let comision = '';
  const descripcion = [];
  for (let i = 0; i < parrafos.length; i++) {
    const l = parrafos[i];
    const c = l.match(/^[-•]?\s*Comisi[oó]n\s*:?\s*(.*)$/i);
    if (c) {
      let v = c[1].trim();
      if (!/\d/.test(v) && parrafos[i + 1] && /\d\s*%/.test(parrafos[i + 1])) { v = parrafos[i + 1].trim(); i++; }
      if (/\d/.test(v)) comision = v.replace(/\.$/, '');
      continue;
    }
    if (/^[-•]?\s*Precio\s*:/i.test(l)) continue;
    descripcion.push(l);
  }
  if (!comision) { const c = parrafos.join(' ').match(/Comisi[oó]n:?\s*([0-9.,]+\s*%[^.\n]*)/i); if (c) comision = c[1].trim(); }
  // Dirección
  const val = (etq) => { const i = idx(new RegExp(`^${etq}\\s*:`, 'i')); return i >= 0 ? lineas[i].replace(new RegExp(`^${etq}\\s*:\\s*`, 'i'), '') : ''; };
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const titulo = (h1 ? entidades(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '') || meta('og:title');
  let direccion = '';
  for (let i = 0; i < lineas.length - 1; i++) {
    if (lineas[i] === titulo && /Regi[oó]n|,/.test(lineas[i + 1]) && !/^(Venta|Arriendo|Vendido|Destacado|Share)/i.test(lineas[i + 1])) { direccion = lineas[i + 1]; break; }
  }
  const mapsQ = (html.match(/maps\.google\.[a-z.]+\/\?q=([^"'&\s]+)/i) || [])[1];
  return {
    url, titulo, direccion, comuna: val('Comuna'), region: val('Región'), resumen: meta('og:description') || meta('description'),
    fotos: fotos.slice(0, 24), descripcion, comision, detalle,
    coordenadas: buscarCoordenadas(html), direccionMapa: mapsQ ? decodeURIComponent(mapsQ.replace(/\+/g, ' ')) : '',
  };
}
async function coordenadasREST(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop();
    const j = JSON.parse(await descargarTexto(`https://farmbrokers.cl/wp-json/wp/v2/properties?slug=${encodeURIComponent(slug)}`));
    const pm = j && j[0] && (j[0].property_meta || j[0].meta);
    const loc = pm && (pm.fave_property_location || pm.houzez_geolocation_lat);
    const txtLoc = Array.isArray(loc) ? loc[0] : loc;
    const m = String(txtLoc || '').match(/(-\d{1,2}\.\d+)\s*,\s*(-\d{1,3}\.\d+)/);
    if (m && coordOk(Number(m[1]), Number(m[2]))) return { lat: Number(m[1]), lng: Number(m[2]) };
  } catch (e) { /* el sitio puede no exponer la API */ }
  return null;
}
async function geocodificar(q) {
  try {
    const j = JSON.parse(await descargarTexto(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cl&q=${encodeURIComponent(q)}`));
    if (j && j[0] && coordOk(Number(j[0].lat), Number(j[0].lon))) return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
  } catch (e) { /* sin conexión al geocodificador */ }
  return null;
}
const linkFB = (c) => [c.linkWeb, c.linkPortal].find((u) => esFarmBrokers(String(u || '').trim()));

router.post('/campos/:id/web', async (req, res) => {
  const campo = leer().campos.find((x) => x.id === req.params.id);
  if (!campo) return res.status(404).json({ error: 'No se encontró el campo.' });
  const url = linkFB(campo);
  if (!url) return res.status(400).json({ error: 'Este campo no tiene un link de farmbrokers.cl/propiedad/. Agrégalo en los datos del campo.' });
  let web;
  try { web = analizarPropiedad(await descargarTexto(url.trim()), url.trim()); }
  catch (e) { return res.status(502).json({ error: `No se pudo leer la publicación: ${e.message}` }); }
  let fuente = web.coordenadas ? 'publicacion' : '';
  if (!web.coordenadas) { web.coordenadas = await coordenadasREST(url); if (web.coordenadas) fuente = 'publicacion'; }
  if (!web.coordenadas) {
    const q = web.direccionMapa || [web.comuna || campo.sector, web.region, 'Chile'].filter(Boolean).join(', ');
    web.coordenadas = await geocodificar(q); if (web.coordenadas) fuente = 'comuna';
  }
  web.fuenteUbicacion = fuente; web.fecha = ahora();
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const c = db.campos.find((x) => x.id === req.params.id); if (!c) return null;
    c.web = web;
    if (!c.codigo && web.detalle.id) c.codigo = web.detalle.id;
    registrar(db, autor, `Actualizó ${c.nombre} desde farmbrokers.cl (${web.fotos.length} fotos)`, { col: 'campos', id: c.id });
    return c;
  });
  r ? res.json(r) : res.status(404).json({ error: 'No se encontró el campo.' });
});

// ───────────────────────── Sincronización con farmbrokers.cl ─────────────────────────
let traerPagina = descargarTexto; // reemplazable en pruebas
const slugDe = (u) => { try { const x = new URL(String(u || '').trim()); if (!/^(www\.)?farmbrokers\.cl$/.test(x.hostname)) return ''; const m = x.pathname.match(/^\/propiedad\/([^/]+)/); return m ? decodeURIComponent(m[1]).toLowerCase() : ''; } catch (e) { return ''; } };
const slugsCampo = (c) => [c.linkWeb, c.linkPortal, c.web && c.web.url].map(slugDe).filter(Boolean);
const tituloDeSlug = (sl) => sl.replace(/-/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
const REGION_NOMBRE_A_CODIGO = [[/arica/i, 'XV'], [/tarapac/i, 'I'], [/antofagasta/i, 'II'], [/atacama/i, 'III'], [/coquimbo/i, 'IV'], [/valpara/i, 'V'], [/metropolitana/i, 'RM'],
  [/higgins/i, 'VI'], [/maule/i, 'VII'], [/ñuble|nuble/i, 'XVI'], [/b[ií]o/i, 'VIII'], [/araucan/i, 'IX'], [/los r[ií]os/i, 'XIV'], [/los lagos/i, 'X'], [/ais[eé]n|ays[eé]n/i, 'XI'], [/magallanes/i, 'XII']];
const regionDeNombre = (t) => { for (const [r, c] of REGION_NOMBRE_A_CODIGO) if (r.test(t || '')) return c; return ''; };

async function listarSitio() {
  const enVenta = new Map(), vendidos = new Set();
  // 1) API de WordPress (si está disponible)
  try {
    const estados = {};
    try { for (const t of JSON.parse(await traerPagina('https://farmbrokers.cl/wp-json/wp/v2/property_status?per_page=100&_fields=id,slug,name'))) estados[t.id] = `${t.slug} ${t.name}`; } catch (e) {}
    for (let pag = 1; pag <= 20; pag++) {
      let lista;
      try { lista = JSON.parse(await traerPagina(`https://farmbrokers.cl/wp-json/wp/v2/properties?per_page=100&page=${pag}&_fields=slug,link,title,property_status,modified`)); } catch (e) { break; }
      if (!Array.isArray(lista) || !lista.length) break;
      for (const p of lista) {
        const sl = String(p.slug || slugDe(p.link)).toLowerCase(); if (!sl) continue;
        const est = (p.property_status || []).map((id) => estados[id] || '').join(' ');
        const titulo = entidades(String((p.title && p.title.rendered) || '')) || tituloDeSlug(sl);
        if (/vend/i.test(est)) vendidos.add(sl);
        enVenta.set(sl, { slug: sl, url: p.link || `https://farmbrokers.cl/propiedad/${sl}/`, titulo, lastmod: String(p.modified || '') });
      }
      if (lista.length < 100) break;
    }
    if (enVenta.size >= 10) return { publicadas: enVenta, vendidos, fuente: 'api' };
  } catch (e) {}
  enVenta.clear(); vendidos.clear();
  // 2) Mapa del sitio (Yoast) y 3) páginas de listado por estado
  const agregar = (html, destino) => {
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?farmbrokers\.cl\/propiedad\/([^/"'<\s#?]+)\/?/gi)) {
      const sl = decodeURIComponent(m[1]).toLowerCase();
      if (!destino.has(sl)) destino.set(sl, { slug: sl, url: `https://farmbrokers.cl/propiedad/${sl}/`, titulo: tituloDeSlug(sl) });
    }
  };
  let fuente = '';
  for (const mapa of ['https://farmbrokers.cl/property-sitemap.xml', 'https://farmbrokers.cl/properties-sitemap.xml']) {
    try {
      const xml = await traerPagina(mapa);
      for (const u of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
        const loc = (u[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1], mod = (u[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1];
        const sl = slugDe(loc); if (sl && !enVenta.has(sl)) enVenta.set(sl, { slug: sl, url: `https://farmbrokers.cl/propiedad/${sl}/`, titulo: tituloDeSlug(sl), lastmod: mod || '' });
      }
      if (!enVenta.size) agregar(xml, enVenta);
      if (enVenta.size) { fuente = 'sitemap'; break; }
    } catch (e) {}
  }
  const recorrer = async (estado, destino) => {
    for (let pag = 1; pag <= 40; pag++) {
      const antes = destino.size;
      let html;
      try { html = await traerPagina(`https://farmbrokers.cl/estado/${estado}/${pag > 1 ? `page/${pag}/` : ''}`); } catch (e) { break; }
      const cuerpo = html.split(/Anuncios Similares|<footer/i)[0];
      agregar(cuerpo, destino);
      if (destino.size === antes) break;
    }
  };
  const mapaVendidos = new Map(); await recorrer('vendido', mapaVendidos);
  for (const sl of mapaVendidos.keys()) vendidos.add(sl);
  if (!fuente) { await recorrer('en-venta', enVenta); await recorrer('arriendo', enVenta); for (const [k, v] of mapaVendidos) enVenta.set(k, v); fuente = 'listados'; }
  return { publicadas: enVenta, vendidos, fuente };
}

// Copia al campo los datos publicados en la web (la web manda en estos datos)
function aplicarWeb(c, w) {
  const d = w.detalle || {}, cambios = [];
  const set = (k, v, etq, fmt = (x) => x) => {
    if (v === '' || v == null || (typeof v === 'number' && isNaN(v))) return;
    if (typeof v === 'string' && /^0+([.,]0+)?\s*(has?|l\/s|lts?)?$/i.test(v.trim())) return; // la web muestra "0 Has" cuando no hay dato
    const antes = c[k];
    if (norm(String(antes == null ? '' : antes)) === norm(String(v))) return;
    cambios.push(antes === '' || antes == null ? `${etq}: ${fmt(v)}` : `${etq}: ${fmt(antes)} → ${fmt(v)}`);
    c[k] = v;
  };
  set('hectareas', parseHa(d.superficie), 'Superficie', (x) => `${String(x).replace('.', ',')} ha`);
  set('agua', txt(d.agua, 200), 'Agua');
  set('plantaciones', txt(d.plantaciones, 300), 'Plantaciones');
  const pr = parsePrecio(d.precio || '');
  if (pr.precioTexto) { set('precioTexto', pr.precioTexto, 'Precio'); c.precioUF = pr.precioUF; c.precioCLP = pr.precioCLP; }
  set('sector', txt(w.comuna, 120), 'Comuna');
  set('region', regionDeNombre(w.region), 'Región');
  set('codigo', txt(d.id, 40), 'ID');
  if (d.tipo) set('tipo', tipoNorm(d.tipo), 'Tipo');
  c.web = w;
  c.checklist = { ...(c.checklist || {}), publicacion: true, fotos: !!((c.checklist || {}).fotos || w.fotos.length) };
  return cambios;
}
function campoDesdeWeb(url, w, autor, etapa) {
  return { id: id(), ...limpiar('campos', { nombre: w.titulo || tituloDeSlug(slugDe(url)), etapa, linkWeb: url, checklist: {} }),
    historial: [{ fecha: ahora(), autor, texto: 'Agregado desde farmbrokers.cl' }], envios: [], creado: ahora(), actualizado: ahora() };
}
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

let sincronizando = null;
async function sincronizarWeb(autor = 'Sincronización web') {
  if (sincronizando) return sincronizando;
  sincronizando = (async () => {
    const inicio = ahora();
    let sitio;
    try { sitio = await listarSitio(); } catch (e) { sitio = null; }
    const db0 = leer();
    const enlazados = db0.campos.filter((c) => slugsCampo(c).length);
    const encontrados = enlazados.filter((c) => slugsCampo(c).some((sl) => sitio && sitio.publicadas.has(sl))).length;
    if (!sitio || sitio.publicadas.size < 5 || (enlazados.length >= 6 && encontrados < enlazados.length * 0.5)) {
      const error = !sitio || !sitio.publicadas.size ? 'No se pudo leer el listado de farmbrokers.cl. No se hicieron cambios.'
        : `La web mostró ${sitio.publicadas.size} publicaciones y solo coinciden ${encontrados} de ${enlazados.length} campos enlazados. Por seguridad no se hicieron cambios.`;
      await modificar((db) => { db.sync = { ...(db.sync || {}), fecha: inicio, error, nuevos: (db.sync && db.sync.nuevos) || [] }; });
      return leer().sync;
    }
    // 1) Confirmar retiros consultando cada página (404 = borrada)
    const candidatos = enlazados.filter((c) => ['Mandato firmado', 'Publicado', 'En negociación', 'Documentación', 'Arrendado', 'Suspendido'].includes(c.etapa)
      && !slugsCampo(c).some((sl) => sitio.publicadas.has(sl)));
    const borrados = new Set();
    for (const c of candidatos.slice(0, 40)) {
      try { await traerPagina(`https://farmbrokers.cl/propiedad/${slugsCampo(c)[0]}/`); }
      catch (e) { if (/respondi[oó] (404|410)/.test(e.message)) borrados.add(c.id); }
    }
    // 2) Leer las publicaciones nuevas y las que cambiaron desde la última revisión
    const ignorados0 = new Set((db0.sync && db0.sync.ignorados) || []);
    const enCRM0 = new Set(db0.campos.flatMap(slugsCampo));
    const nuevas = [...sitio.publicadas.values()].filter((p) => !enCRM0.has(p.slug) && !ignorados0.has(p.slug));
    const cambiadas = [];
    for (const c of db0.campos) {
      const sl = slugsCampo(c).find((x) => sitio.publicadas.has(x)); if (!sl) continue;
      const p = sitio.publicadas.get(sl);
      const viejo = !c.web || !c.web.fecha || Date.now() - new Date(c.web.fecha).getTime() > 20 * 3600 * 1000;
      if (!c.web || (p.lastmod ? p.lastmod !== c.web.lastmod : viejo)) cambiadas.push(p);
    }
    const leidas = new Map();
    for (const p of [...nuevas, ...cambiadas].slice(0, 250)) {
      try { const w = analizarPropiedad(await traerPagina(p.url), p.url); w.lastmod = p.lastmod || ''; w.fecha = ahora(); w.fuenteUbicacion = w.coordenadas ? 'publicacion' : ''; leidas.set(p.slug, w); }
      catch (e) { /* se reintenta en la próxima revisión */ }
      await pausa(120);
    }
    // 3) Aplicar todo en una sola escritura
    const res = await modificar((db) => {
      const cambios = { retirados: [], vendidos: [], restaurados: [], creados: [], vinculados: [], actualizados: [] };
      const nota = (c, t) => { c.historial = [...(c.historial || []), { fecha: ahora(), autor, texto: t }]; c.actualizado = ahora(); };
      for (const c of db.campos) {
        const sls = slugsCampo(c); if (!sls.length) continue;
        if (borrados.has(c.id)) {
          nota(c, `Etapa: ${c.etapa} → Retirado de la web (la publicación ya no existe en farmbrokers.cl)`);
          c.etapaAntesDeRetiro = c.etapa; c.etapa = 'Retirado de la web'; cambios.retirados.push(c.nombre); continue;
        }
        const w = sls.map((sl) => leidas.get(sl)).find(Boolean);
        if (w) {
          const cm = aplicarWeb(c, w);
          if (cm.length) { nota(c, `Actualizado desde farmbrokers.cl: ${cm.join('; ')}`); cambios.actualizados.push({ nombre: c.nombre, cambios: cm }); }
        }
        if (sls.some((sl) => sitio.vendidos.has(sl)) && !['Vendido', 'Descartado'].includes(c.etapa)) {
          nota(c, `Etapa: ${c.etapa} → Vendido (marcado como vendido en farmbrokers.cl)`); c.etapa = 'Vendido'; cambios.vendidos.push(c.nombre);
        } else if (c.etapa === 'Retirado de la web' && sls.some((sl) => sitio.publicadas.has(sl) && !sitio.vendidos.has(sl))) {
          const vuelve = c.etapaAntesDeRetiro || 'Publicado';
          nota(c, `Etapa: Retirado de la web → ${vuelve} (volvió a publicarse en farmbrokers.cl)`); c.etapa = vuelve; cambios.restaurados.push(c.nombre);
        }
      }
      // Publicaciones que no estaban enlazadas: primero se busca el mismo campo en el CRM, si no existe se crea
      for (const p of nuevas) {
        const w = leidas.get(p.slug); if (!w) continue;
        if (db.campos.some((c) => slugsCampo(c).includes(p.slug))) continue;
        const idWeb = norm((w.detalle || {}).id).toUpperCase();
        const sinEnlace = db.campos.filter((c) => !slugsCampo(c).length);
        const mismo = (idWeb.length >= 5 && sinEnlace.find((c) => norm(c.codigo).toUpperCase() === idWeb))
          || sinEnlace.find((c) => norm(c.nombre) === norm(w.titulo) && (!c.sector || !w.comuna || norm(c.sector) === norm(w.comuna)));
        const vendida = sitio.vendidos.has(p.slug);
        if (mismo) {
          mismo.linkWeb = p.url; const cm = aplicarWeb(mismo, w);
          nota(mismo, `Enlazado con su publicación en farmbrokers.cl${cm.length ? `: ${cm.join('; ')}` : ''}`);
          cambios.vinculados.push(mismo.nombre);
        } else {
          const c = campoDesdeWeb(p.url, w, autor, vendida ? 'Vendido' : 'Publicado');
          aplicarWeb(c, w); db.campos.push(c); cambios.creados.push(c.nombre);
        }
      }
      const enCRM = new Set(db.campos.flatMap(slugsCampo));
      const ignorados = new Set((db.sync && db.sync.ignorados) || []);
      const pendientes = [...sitio.publicadas.values()].filter((p) => !enCRM.has(p.slug) && !sitio.vendidos.has(p.slug) && !ignorados.has(p.slug));
      if (cambios.retirados.length) registrar(db, autor, `Retiró ${cambios.retirados.length === 1 ? 'un campo que ya no está' : `${cambios.retirados.length} campos que ya no están`} en la web: ${cambios.retirados.join(', ')}`, null);
      if (cambios.vendidos.length) registrar(db, autor, `Marcó como vendidos (según la web): ${cambios.vendidos.join(', ')}`, null);
      if (cambios.restaurados.length) registrar(db, autor, `Volvieron a publicarse en la web: ${cambios.restaurados.join(', ')}`, null);
      if (cambios.creados.length) registrar(db, autor, `Agregó ${plural(cambios.creados.length, 'campo')} desde farmbrokers.cl`, null);
      if (cambios.vinculados.length) registrar(db, autor, `Enlazó con la web ${cambios.vinculados.length === 1 ? 'un campo que ya estaba' : `${cambios.vinculados.length} campos que ya estaban`} en el CRM: ${cambios.vinculados.join(', ')}`, null);
      if (cambios.actualizados.length) registrar(db, autor, `Actualizó desde la web: ${cambios.actualizados.map((a) => a.nombre).join(', ')}`, null);
      db.sync = { fecha: inicio, fuente: sitio.fuente, publicadas: sitio.publicadas.size, vendidosWeb: sitio.vendidos.size, ...cambios,
        leidas: leidas.size, nuevos: pendientes, ignorados: [...ignorados], error: '' };
      return db.sync;
    });
    return res;
  })();
  try { return await sincronizando; } finally { sincronizando = null; }
}
const plural = (n, s, p) => `${n} ${n === 1 ? s : p || s + 's'}`;

router.post('/sync', async (req, res) => {
  const esperar = !!(req.body || {}).esperar;
  const tarea = sincronizarWeb(usuarioDe(req)).catch(() => null);
  if (esperar) return res.json(await tarea);
  res.json({ enCurso: true });
});

// Agregar al CRM un campo que está en la web
router.post('/sync/agregar', async (req, res) => {
  const slug = String((req.body || {}).slug || '').toLowerCase();
  if (!/^[a-z0-9%_-]+$/i.test(slug)) return res.status(400).json({ error: 'Publicación no válida.' });
  const url = `https://farmbrokers.cl/propiedad/${slug}/`;
  let web;
  try { web = analizarPropiedad(await traerPagina(url), url); } catch (e) { return res.status(502).json({ error: `No se pudo leer la publicación: ${e.message}` }); }
  if (!web.coordenadas) web.coordenadas = await coordenadasREST(url);
  web.fuenteUbicacion = web.coordenadas ? 'publicacion' : ''; web.fecha = ahora();
  const autor = usuarioDe(req), d = web.detalle;
  const r = await modificar((db) => {
    if (db.campos.some((c) => slugsCampo(c).includes(slug))) return { error: 'Ese campo ya está en el CRM.' };
    const campo = campoDesdeWeb(url, web, autor, /vend/i.test(d.estado || '') ? 'Vendido' : 'Publicado');
    aplicarWeb(campo, web);
    db.campos.push(campo);
    if (db.sync) db.sync.nuevos = (db.sync.nuevos || []).filter((n) => n.slug !== slug);
    registrar(db, autor, `Agregó ${campo.nombre} desde farmbrokers.cl`, { col: 'campos', id: campo.id });
    return campo;
  });
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

// Marcar una publicación como "no agregar" (por ejemplo, ya existe con otro nombre)
router.post('/sync/ignorar', async (req, res) => {
  const slug = String((req.body || {}).slug || '').toLowerCase();
  const r = await modificar((db) => {
    db.sync = db.sync || { nuevos: [] };
    db.sync.ignorados = [...new Set([...(db.sync.ignorados || []), slug])];
    db.sync.nuevos = (db.sync.nuevos || []).filter((n) => n.slug !== slug);
    return db.sync;
  });
  res.json(r);
});

// Revisión automática cada 6 horas (y un minuto después de arrancar el servidor)
if (!process.env.CRM_SYNC_OFF) {
  const tarea = () => { if (process.env.CRM_KEY) sincronizarWeb().catch(() => {}); };
  setTimeout(tarea, 60 * 1000).unref();
  setInterval(tarea, 6 * 3600 * 1000).unref();
}

// ───────────────────────── Tipos de propiedad agregados por el equipo ─────────────────────────
router.post('/tipos', async (req, res) => {
  const nombre = txt((req.body || {}).nombre, 40);
  if (nombre.length < 3) return res.status(400).json({ error: 'Escribe un nombre de al menos 3 letras.' });
  const clave = norm(nombre).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (!clave) return res.status(400).json({ error: 'Nombre no válido.' });
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const existente = Object.entries({ ...TIPOS_BASE, ...(db.tiposExtra || {}) }).find(([k, l]) => k === clave || norm(l) === norm(nombre));
    if (existente) return { clave: existente[0], tipos: { ...TIPOS_BASE, ...(db.tiposExtra || {}) }, existia: true };
    db.tiposExtra = { ...(db.tiposExtra || {}), [clave]: nombre.charAt(0).toUpperCase() + nombre.slice(1) };
    tiposExtra = db.tiposExtra;
    registrar(db, autor, `Agregó el tipo de propiedad "${db.tiposExtra[clave]}"`, null);
    return { clave, tipos: todosLosTipos() };
  });
  res.json(r);
});

// ───────────────────────── Tasaciones guardadas desde la plataforma ─────────────────────────
// Se leen del mismo disco donde almacen.js guarda cada tasación (carpeta "tasaciones").
const DIR_TAS_PLATAFORMA = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'datos-locales'), 'tasaciones');
const cacheTas = new Map(); // id -> { mtime, resumen }
function resumenTasacion(reg) {
  const f = reg.datos || {}, roles = Array.isArray(f.roles) ? f.roles : [];
  const r0 = roles[0] || {}, d0 = r0.datos || {};
  const sup = parseHa(f.superfTitulos) || roles.reduce((s, r) => s + (parseHa((r.datos || {}).superfSII) || 0), 0) || parseHa(f.superfGoogleEarth) || null;
  const uf = parsePrecio(`UF ${String(f.valorComercialUF || '').replace(/[^\d.,]/g, '')}`).precioUF;
  return {
    id: reg.id, nombre: reg.nombre, guardado: reg.guardado, numero: f.numTasacion || '', predio: f.predioNombre || '',
    roles: roles.map((r) => r.rol).filter(Boolean), comuna: r0.comuna || f.localidad || '', region: regionDeNombre(f.region) || regionCodigo(f.region),
    hectareas: sup ? Math.round(sup * 100) / 100 : null, valorUF: uf || null, propietario: d0.propietario || '', solicitante: f.solicitante || '',
  };
}
function listarTasacionesPlataforma() {
  if (!fs.existsSync(DIR_TAS_PLATAFORMA)) return [];
  const out = [];
  for (const arch of fs.readdirSync(DIR_TAS_PLATAFORMA)) {
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(arch)) continue;
    const ruta = path.join(DIR_TAS_PLATAFORMA, arch);
    try {
      const mtime = fs.statSync(ruta).mtimeMs, id = arch.slice(0, -5);
      const c = cacheTas.get(id);
      if (c && c.mtime === mtime) { out.push(c.resumen); continue; }
      const resumen = resumenTasacion(JSON.parse(fs.readFileSync(ruta, 'utf8')));
      cacheTas.set(id, { mtime, resumen }); out.push(resumen);
    } catch (e) { /* archivo dañado o a medio escribir: se omite */ }
  }
  return out.sort((a, b) => String(b.guardado).localeCompare(String(a.guardado)));
}
function textoLista(v) {
  if (!v) return '';
  try {
    const a = JSON.parse(v);
    if (Array.isArray(a)) return a.map((x) => (typeof x === 'object' && x ? Object.values(x).filter((y) => typeof y === 'string' || typeof y === 'number').join(' ') : String(x))).filter(Boolean).join('; ');
    if (a && typeof a === 'object') return Object.entries(a).map(([k, x]) => `${k}: ${x}`).join('; ');
  } catch (e) { /* texto normal */ }
  return String(v);
}

router.get('/plataforma/tasaciones', (req, res) => {
  const db = leer();
  const lista = listarTasacionesPlataforma().map((t) => {
    const campo = db.campos.find((c) => c.origenTasacion === t.id);
    return { ...t, campoId: campo ? campo.id : null, campoNombre: campo ? campo.nombre : '' };
  });
  res.json({ tasaciones: lista, hayCarpeta: fs.existsSync(DIR_TAS_PLATAFORMA) });
});

// Convierte una tasación de la plataforma (su formulario) en campo del CRM, o completa el que ya existe
function campoDesdeTasacion(db, reg, tid, autor, campoId = '') {
  const f = reg.datos || {}, t = resumenTasacion(reg), d0 = ((f.roles || [])[0] || {}).datos || {};
  const lat = parseFloat(String(f.coordLat || '').replace(',', '.')), lng = parseFloat(String(f.coordLon || '').replace(',', '.'));
  const datosCampo = {
    nombre: t.predio || String(reg.nombre || '').replace(/\s*\[[^\]]*\]\s*$/, '') || (t.comuna ? `Campo en ${t.comuna}` : 'Campo desde tasación'),
    rol: t.roles.join(', '), sector: t.comuna, region: t.region, hectareas: t.hectareas,
    propietario: t.propietario, email: f.email || '', agua: textoLista(f.recursosHidricos).slice(0, 380),
    plantaciones: f.plantacionDesc || textoLista(f.plantacionesCIREN).slice(0, 380), aptitud: f.aptitud || '',
    coordenadas: coordOk(lat, lng) ? `${lat}, ${lng}` : '', acceso: txt(f.acceso, 400),
  };
  const L = (v) => textoLista(v).trim();
  const infoTas = {
    suelos: [f.seriesSuelo && `Serie ${f.seriesSuelo}`, f.textura && `textura ${f.textura}`, f.profundidad && `profundidad ${f.profundidad}`, f.drenaje && `drenaje ${f.drenaje}`,
      f.pendiente && `pendiente ${f.pendiente}`, f.erosion && `erosión ${f.erosion}`, f.capacidadUso && `capacidad de uso ${f.capacidadUso}`].filter(Boolean).join(', '),
    clima: txt(f.climaTxt, 1200), aguas: L(f.recursosHidricos).slice(0, 1200), escasez: txt(f.escasezTxt, 400),
    construcciones: [f.construcciones && !/no posee construcciones/i.test(f.construcciones) ? f.construcciones : '', L(f.construccionesLista)].filter(Boolean).join('. ').slice(0, 1200),
    instalaciones: L(f.instalacionesLista).slice(0, 800), usos: L(f.usosCIREN).slice(0, 800), plantaciones: [f.plantacionDesc, L(f.plantacionesCIREN)].filter(Boolean).join('. ').slice(0, 800),
    deslindes: [f.deslindeN && `Norte: ${f.deslindeN}`, f.deslindeS && `Sur: ${f.deslindeS}`, f.deslindeO && `Oriente: ${f.deslindeO}`, f.deslindeP && `Poniente: ${f.deslindeP}`].filter(Boolean).join('; ').slice(0, 800),
    distSantiago: txt(f.distSantiago, 80), distComuna: txt(f.distComuna, 80), altitud: txt(f.altitud, 40), acceso: txt(f.acceso, 400),
    conclusion: txt(f.guiaConclusion, 1500), numero: t.numero || '',
  };
  let geoTas = null;
  try { const lista = JSON.parse(f.prediosGeo || '[]'); geoTas = armarGeo((Array.isArray(lista) ? lista : [lista]).flatMap((x) => anillosDeGeoJSON(x && x.type ? x : x && x.g)), 'tasacion'); } catch (e) { geoTas = null; }
  const notas = [
    `Tasación ${t.numero || reg.nombre || ''}${reg.guardado ? ` (${String(reg.guardado).slice(0, 10)})` : ''}.`,
    f.valorComercialUF ? `Valor comercial según tasación: UF ${f.valorComercialUF}.` : '',
    f.valorFacilVentaUF ? `Valor de fácil venta: UF ${f.valorFacilVentaUF}.` : '',
    t.solicitante ? `Solicitante: ${t.solicitante}.` : '',
    f.acceso ? `Acceso: ${f.acceso}` : '',
  ].filter(Boolean).join('\n');
  let campo = (campoId && db.campos.find((c) => c.id === campoId)) || db.campos.find((c) => c.origenTasacion === tid) || (t.numero ? db.campos.find((c) => c.origenTasacionNum === t.numero) : null);
  const existia = !!campo;
  const completados = [];
  if (!campo) {
    campo = { id: id(), ...limpiar('campos', { ...datosCampo, etapa: 'Captación', tipo: 'agricola', observaciones: notas, responsable: autor,
      checklist: { avaluo: !!(d0.avaluoFiscal), plano: !!(f.prediosGeo) } }),
      origenTasacion: tid, origenTasacionNum: t.numero || '', historial: [{ fecha: ahora(), autor, texto: `Creado desde la tasación ${t.numero || reg.nombre || ''}` }], envios: [], creado: ahora(), actualizado: ahora() };
    db.campos.push(campo);
  } else {
    const limpio = limpiar('campos', { ...campo, ...Object.fromEntries(Object.entries(datosCampo).filter(([k, v]) => (campo[k] === '' || campo[k] == null) && v !== '' && v != null)) });
    for (const k of Object.keys(datosCampo)) if ((campo[k] === '' || campo[k] == null) && limpio[k] !== '' && limpio[k] != null) { campo[k] = limpio[k]; completados.push(k); }
    const valorNota = notas.split('\n').find((l) => l.startsWith('Valor comercial'));
    if (valorNota && !String(campo.observaciones || '').includes(valorNota)) campo.observaciones = [campo.observaciones, valorNota].filter(Boolean).join('\n');
    campo.origenTasacion = campo.origenTasacion || tid; campo.origenTasacionNum = campo.origenTasacionNum || t.numero || '';
    campo.historial = [...(campo.historial || []), { fecha: ahora(), autor, texto: `Actualizado desde la tasación ${t.numero || ''}${completados.length ? ` (completó: ${completados.join(', ')})` : ' (sin cambios)'}` }];
    campo.actualizado = ahora();
  }
  // Seguimiento de la tasación en el CRM
  const etapaTas = f.valorComercial || f.valorComercialUF ? 'Informe entregado' : 'En terreno';
  let tas = db.tasaciones.find((x) => x.campoId === campo.id) || (t.numero ? db.tasaciones.find((x) => x.codigo && x.codigo === t.numero) : null);
  if (tas) {
    tas.campoId = campo.id; if (!tas.codigo && t.numero) tas.codigo = t.numero;
    if (etapaTas === 'Informe entregado' && ETAPAS.tasaciones.indexOf(tas.etapa) < ETAPAS.tasaciones.indexOf('Informe entregado')) {
      tas.historial = [...(tas.historial || []), { fecha: ahora(), autor, texto: `Etapa: ${tas.etapa} → Informe entregado` }]; tas.etapa = 'Informe entregado';
    }
    tas.actualizado = ahora();
  } else {
    tas = { id: id(), ...limpiar('tasaciones', { titulo: `Tasación ${campo.nombre}`, cliente: t.solicitante || t.propietario, email: f.email || '', campoId: campo.id,
      rol: campo.rol, comuna: campo.sector, codigo: t.numero, etapa: etapaTas, responsable: autor }),
      historial: [{ fecha: ahora(), autor, texto: 'Registrada desde la plataforma de tasaciones' }], envios: [], creado: ahora(), actualizado: ahora() };
    db.tasaciones.push(tas);
  }
  if (geoTas && !(campo.geo && campo.geo.fuente === 'kmz')) { aplicarGeo(campo, geoTas); if (existia) completados.push('plano del predio'); }
  if (Object.values(infoTas).some((v) => v && v !== infoTas.numero)) { campo.tasacionInfo = infoTas; if (existia) completados.push('antecedentes de la tasación'); }
  registrar(db, autor, `${existia ? 'Actualizó' : 'Creó'} el campo ${campo.nombre} desde la tasación ${t.numero || reg.nombre || ''}`, { col: 'campos', id: campo.id });
  return { campo, tasacion: tas, existia, completados };
}

router.post('/plataforma/tasaciones/:id/campo', async (req, res) => {
  const tid = req.params.id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) return res.status(400).json({ error: 'Tasación no válida.' });
  let reg;
  try { reg = JSON.parse(fs.readFileSync(path.join(DIR_TAS_PLATAFORMA, `${tid}.json`), 'utf8')); }
  catch (e) { return res.status(404).json({ error: 'No se encontró esa tasación en la nube.' }); }
  const autor = usuarioDe(req);
  res.json(await modificar((db) => campoDesdeTasacion(db, reg, tid, autor)));
});

// Botón "Crear en CRM" de la plataforma: recibe los datos del formulario abierto (aunque no esté guardado)
router.post('/plataforma/campo', async (req, res) => {
  const b = req.body || {};
  const datos = b.datos && typeof b.datos === 'object' ? b.datos : null;
  if (!datos) return res.status(400).json({ error: 'No llegaron los datos de la tasación.' });
  const tieneAlgo = datos.predioNombre || (Array.isArray(datos.roles) && datos.roles.some((r) => r && (r.rol || r.comuna))) || datos.localidad;
  if (!tieneAlgo) return res.status(400).json({ error: 'Completa al menos el nombre del predio, un rol o la comuna antes de crear el campo.' });
  const idOk = /^[A-Za-z0-9_-]{1,64}$/.test(String(b.tasacionId || ''));
  const tid = idOk ? b.tasacionId : datos.numTasacion ? `num_${String(datos.numTasacion).replace(/[^A-Za-z0-9_-]/g, '')}` : `form_${Date.now()}`;
  const reg = { id: tid, nombre: txt(b.nombre, 200) || datos.predioNombre || '', guardado: ahora(), datos };
  const autor = usuarioDe(req);
  res.json(await modificar((db) => campoDesdeTasacion(db, reg, tid, autor, txt(b.campoId, 60))));
});

// Crear un campo a partir de una tasación registrada en el CRM
router.post('/tasaciones/:id/campo', async (req, res) => {
  const autor = usuarioDe(req);
  const r = await modificar((db) => {
    const tas = db.tasaciones.find((x) => x.id === req.params.id);
    if (!tas) return null;
    const previo = tas.campoId && db.campos.find((c) => c.id === tas.campoId);
    if (previo) return { campo: previo, existia: true };
    const campo = { id: id(), ...limpiar('campos', {
      nombre: tas.titulo.replace(/^Tasaci[oó]n\s+(de\s+)?/i, '') || tas.titulo, etapa: 'Captación', tipo: 'agricola', rol: tas.rol, sector: tas.comuna,
      propietario: tas.cliente, telefono: tas.telefono, email: tas.email, responsable: autor,
      observaciones: `Creado desde la tasación ${tas.codigo || tas.titulo}.`,
    }), historial: [{ fecha: ahora(), autor, texto: `Creado desde la tasación ${tas.codigo || tas.titulo}` }], envios: [], creado: ahora(), actualizado: ahora() };
    db.campos.push(campo);
    tas.campoId = campo.id;
    tas.historial = [...(tas.historial || []), { fecha: ahora(), autor, texto: `Se creó el campo ${campo.nombre}` }];
    registrar(db, autor, `Creó el campo ${campo.nombre} desde la tasación ${tas.codigo || tas.titulo}`, { col: 'campos', id: campo.id });
    return { campo };
  });
  r ? res.json(r) : res.status(404).json({ error: 'No se encontró la tasación.' });
});

router._interno = { setTraerBinario: (f) => { traerBinario = f; }, sugerirCampo, kmlPersonalizado, zipUno, leerZip, antecedentesCampo, setClaude: (f) => { global.__claudeMock = f; }, geoDeArchivo, armarGeo, anillosDeGeoJSON, resumenTasacion, campoDesdeTasacion, tipoNorm,  sincronizarWeb, listarSitio, setTraer: (f) => { traerPagina = f; },  analizarPropiedad, buscarCoordenadas,  bloquesMandato, faltantesMandato, rutValido, limpiarDatosPropietario,  importarHojas, evaluar, calcularMatches, parseRegiones, parseHa, parsePrecio, parseRango, parseFechaMY, cultivosEn };
module.exports = router;
