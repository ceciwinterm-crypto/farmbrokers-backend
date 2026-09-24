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
const VERSION = 'crm-v3.0';
const ARCHIVOS = path.join(DIR, 'archivos');

// ───────────────────────── Catálogos ─────────────────────────
const ETAPAS = {
  campos: ['Prospección', 'Captación', 'Documentación', 'Mandato firmado', 'Publicado', 'En negociación', 'Vendido', 'Arrendado', 'Suspendido', 'Descartado'],
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
const TIPOS = ['agricola', 'loteo', 'urbano', 'forestal', 'conservacion', 'energia'];
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
  'responsable', 'proximaAccion', 'proximaFecha', 'fechaIngreso', 'estadoPlanilla'];
const CAMPOS_CLIENTE = ['nombre', 'contactoNombre', 'telefono', 'email', 'requerimiento', 'tipo', 'regiones', 'zona', 'haMin', 'haMax', 'cultivos',
  'presupuesto', 'operacion', 'observaciones', 'corredor', 'mailing', 'fechaRequerimiento', 'etapa', 'responsable', 'proximaAccion', 'proximaFecha', 'revisar'];
const CAMPOS_TASACION = ['titulo', 'cliente', 'telefono', 'email', 'campoId', 'rol', 'comuna', 'codigo', 'etapa', 'honorariosUF', 'responsable', 'proximaAccion', 'proximaFecha'];

function limpiar(col, b, previo = {}) {
  const o = { ...previo, ...b };
  const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  if (col === 'campos') {
    const r = {};
    for (const k of CAMPOS_CAMPO) r[k] = txt(o[k], k === 'observaciones' ? 4000 : 400);
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
};
const NOMBRE_CULTIVO = { paltos: 'paltos', citricos: 'cítricos', nogales: 'nogales', cerezos: 'cerezos', avellanos: 'avellanos', almendros: 'almendros',
  manzanos: 'manzanos', perales: 'perales', carozos: 'carozos', uva_mesa: 'uva de mesa', vinas: 'viñas', olivos: 'olivos', berries: 'berries',
  ganaderia: 'ganadería', forestal: 'forestal', cultivos_anuales: 'cultivos anuales', frutales: 'frutales' };

function evaluar(campo, cli, hoy = new Date()) {
  // tipo
  let sTipo;
  if (!cli.tipo) sTipo = 5;
  else { sTipo = (COMPAT[cli.tipo] || {})[campo.tipo]; if (sTipo == null) return null; }
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
    if (['Vendido', 'Descartado', 'Prospección'].includes(campo.etapa)) continue;
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
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { ...vacio(), ...d }; }
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
  if (req.path.startsWith('/publico/')) return next();
  const clave = process.env.CRM_KEY;
  if (!clave) return res.status(500).json({ error: 'Falta la variable CRM_KEY en Railway.' });
  if (req.get('x-crm-key') !== clave) return res.status(401).json({ error: 'Clave del equipo incorrecta.' });
  next();
});

router.get('/', (req, res) => {
  const db = leer();
  res.json({ version: VERSION, etapas: ETAPAS, checklist: CHECKLIST, activas: CAMPO_ACTIVAS, ofrecibles: CAMPO_OFRECIBLES,
    cultivos: NOMBRE_CULTIVO, regiones: REGIONES, campos: db.campos, clientes: db.clientes, tasaciones: db.tasaciones,
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

router._interno = { bloquesMandato, faltantesMandato, rutValido, limpiarDatosPropietario,  importarHojas, evaluar, calcularMatches, parseRegiones, parseHa, parsePrecio, parseRango, parseFechaMY, cultivosEn };
module.exports = router;
