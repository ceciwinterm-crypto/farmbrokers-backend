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
const VERSION = 'crm-v2.0';

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

router._interno = { importarHojas, evaluar, calcularMatches, parseRegiones, parseHa, parsePrecio, parseRango, parseFechaMY, cultivosEn };
module.exports = router;
