// ============================================================================
//  almacen.js — Respaldo de tasaciones en el disco persistente de Railway
//  Farm Brokers Chile
//
//  Cada tasacion es un archivo JSON en el disco montado. El disco sobrevive a
//  los reinicios y despliegues, de modo que las tasaciones dejan de depender de
//  un solo navegador. Ademas el correlativo (T-2026-011) pasa a asignarse aqui:
//  asi nunca se repite aunque se trabaje desde varios computadores.
// ============================================================================

const fs = require('fs');
const path = require('path');

// Railway publica la ruta del volumen en RAILWAY_VOLUME_MOUNT_PATH al arrancar.
// Si no hay disco montado, se cae a una carpeta local: la app sigue funcionando,
// pero el respaldo NO es permanente (se avisa en /almacen-estado).
const RAIZ = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'datos-locales');
const DIR_TAS = path.join(RAIZ, 'tasaciones');
const DIR_VER = path.join(RAIZ, 'versiones');
const ARCH_CORR = path.join(RAIZ, 'correlativo.json');
const HAY_DISCO = !!process.env.RAILWAY_VOLUME_MOUNT_PATH;

function asegurarCarpetas() {
  [RAIZ, DIR_TAS, DIR_VER].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

// Solo se aceptan identificadores propios (evita que un id manipulado escriba
// fuera de la carpeta, por ejemplo con "../").
const idValido = id => /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));

function rutaDe(id) { return path.join(DIR_TAS, id + '.json'); }

// ── Guardar ─────────────────────────────────────────────────────────────────
// Antes de sobreescribir, la version anterior se copia a /versiones (se conservan
// las 3 ultimas). Es la red de seguridad ante un guardado equivocado.
function guardar(id, nombre, datos) {
  asegurarCarpetas();
  if (!idValido(id)) throw new Error('Identificador de tasacion invalido');
  const ruta = rutaDe(id);
  if (fs.existsSync(ruta)) {
    try {
      const marca = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(ruta, path.join(DIR_VER, id + '__' + marca + '.json'));
      const viejas = fs.readdirSync(DIR_VER).filter(f => f.startsWith(id + '__')).sort();
      viejas.slice(0, Math.max(0, viejas.length - 3))
            .forEach(f => { try { fs.unlinkSync(path.join(DIR_VER, f)); } catch (e) {} });
    } catch (e) { /* si falla la copia de respaldo, igual se guarda lo nuevo */ }
  }
  const registro = { id, nombre: String(nombre || 'Tasacion'), guardado: new Date().toISOString(), datos };
  // Escritura atomica: primero a un temporal y luego se renombra, para que un
  // corte a medias no deje el archivo corrupto.
  const tmp = ruta + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registro));
  fs.renameSync(tmp, ruta);
  return { id, nombre: registro.nombre, guardado: registro.guardado, bytes: fs.statSync(ruta).size };
}

// ── Listar (solo la ficha, sin los datos pesados) ───────────────────────────
function listar() {
  asegurarCarpetas();
  return fs.readdirSync(DIR_TAS).filter(f => f.endsWith('.json')).map(f => {
    const ruta = path.join(DIR_TAS, f);
    try {
      const r = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      const d = r.datos || {};
      const roles = (d.roles || []).filter(x => String(x.rol || '').trim());
      return {
        id: r.id, nombre: r.nombre, guardado: r.guardado,
        bytes: fs.statSync(ruta).size,
        numTasacion: d.numTasacion || '',
        predio: d.predioNombre || '',
        comuna: (roles[0] || {}).comuna || '',
        roles: roles.map(x => x.rol).join(' + ')
      };
    } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => String(b.guardado).localeCompare(String(a.guardado)));
}

function obtener(id) {
  if (!idValido(id)) throw new Error('Identificador invalido');
  const ruta = rutaDe(id);
  if (!fs.existsSync(ruta)) return null;
  return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

function borrar(id) {
  if (!idValido(id)) throw new Error('Identificador invalido');
  const ruta = rutaDe(id);
  if (!fs.existsSync(ruta)) return false;
  // No se elimina del todo: queda una copia en /versiones por si fue un error.
  try {
    fs.copyFileSync(ruta, path.join(DIR_VER, id + '__borrada-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
  } catch (e) {}
  fs.unlinkSync(ruta);
  return true;
}

// ── Correlativo por año, asignado por el servidor ───────────────────────────
function siguienteCorrelativo() {
  asegurarCarpetas();
  const anio = new Date().getFullYear();
  let libro = {};
  try { if (fs.existsSync(ARCH_CORR)) libro = JSON.parse(fs.readFileSync(ARCH_CORR, 'utf8')); } catch (e) {}
  // Nunca retroceder: si hay tasaciones guardadas con un numero mayor, se respeta.
  let maximo = 0;
  try {
    listar().forEach(t => {
      const m = /^T-(\d{4})-(\d+)$/.exec(String(t.numTasacion || ''));
      if (m && +m[1] === anio) maximo = Math.max(maximo, +m[2]);
    });
  } catch (e) {}
  const siguiente = Math.max(Number(libro[anio] || 0), maximo) + 1;
  libro[anio] = siguiente;
  fs.writeFileSync(ARCH_CORR, JSON.stringify(libro));
  return 'T-' + anio + '-' + String(siguiente).padStart(3, '0');
}

function estado() {
  asegurarCarpetas();
  const archivos = fs.readdirSync(DIR_TAS).filter(f => f.endsWith('.json'));
  const bytes = archivos.reduce((s, f) => { try { return s + fs.statSync(path.join(DIR_TAS, f)).size; } catch (e) { return s; } }, 0);
  return {
    respaldoPermanente: HAY_DISCO,
    ruta: RAIZ,
    tasaciones: archivos.length,
    espacioUsadoMB: Math.round(bytes / 1048576 * 10) / 10,
    aviso: HAY_DISCO ? null
      : 'No hay disco persistente montado en Railway: las tasaciones se estan guardando en almacenamiento temporal y se PERDERAN en el proximo despliegue. Monta un volumen en el servicio para activar el respaldo real.'
  };
}

module.exports = { guardar, listar, obtener, borrar, siguienteCorrelativo, estado, HAY_DISCO };
