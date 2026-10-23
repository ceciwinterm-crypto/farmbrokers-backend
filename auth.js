// ============================================================================
//  auth.js — Usuarios individuales y sesiones (Farm Brokers Chile)
//
//  - Cada persona entra con su correo y su contraseña.
//  - Las contraseñas se guardan con bcrypt (nunca en texto).
//  - Al entrar se entrega un token de sesión que vence (SESION_DIAS, por defecto 7).
//    En el servidor solo se guarda la huella (SHA-256) del token, no el token.
//  - Dos roles: "admin" (administra usuarios y aprueba eliminaciones) y "corredor".
//  - Mientras PERMITIR_CLAVE_ANTIGUA no sea "0", la clave del equipo (FB_CLAVE /
//    CRM_KEY) sigue funcionando, para que nadie quede fuera durante el cambio.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const RAIZ = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'datos-locales');
const ARCHIVO = path.join(RAIZ, 'usuarios.json');
const SESION_DIAS = Math.max(1, Math.min(90, Number(process.env.SESION_DIAS) || 7));
const ROLES = ['admin', 'corredor'];
const COSTO_BCRYPT = 12;

const claveAntiguaPermitida = () => String(process.env.PERMITIR_CLAVE_ANTIGUA || '1') !== '0';
const ahora = () => new Date().toISOString();
const huella = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const correoOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(String(e || ''));
const limpiarCorreo = (e) => String(e || '').trim().toLowerCase().slice(0, 200);
const limpiarNombre = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 80);

// ── Archivo de usuarios (en el disco persistente de Railway) ────────────────
function leer() {
  try { const d = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); return { usuarios: d.usuarios || [], sesiones: d.sesiones || {}, intentos: d.intentos || {}, restablecer: d.restablecer || {} }; }
  catch (e) { return { usuarios: [], sesiones: {}, intentos: {}, restablecer: {} }; }
}
function guardar(db) {
  fs.mkdirSync(RAIZ, { recursive: true });
  // Se limpian sesiones vencidas e intentos viejos en cada escritura
  const t = Date.now();
  for (const [k, s] of Object.entries(db.sesiones)) if (new Date(s.expira).getTime() < t) delete db.sesiones[k];
  for (const [k, i] of Object.entries(db.intentos)) if (t - new Date(i.ultimo).getTime() > 24 * 3600e3) delete db.intentos[k];
  for (const [k, r] of Object.entries(db.restablecer || {})) if (new Date(r.expira).getTime() < t) delete db.restablecer[k];
  const tmp = ARCHIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, ARCHIVO);
}
let cola = Promise.resolve();
function modificar(fn) { const p = cola.then(() => { const db = leer(); const r = fn(db); guardar(db); return r; }); cola = p.catch(() => {}); return p; }

const publico = (u) => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, activo: u.activo !== false, creado: u.creado, ultimoIngreso: u.ultimoIngreso || '', debeCambiarClave: !!u.debeCambiarClave });
const hayUsuarios = () => leer().usuarios.some((u) => u.activo !== false);

function validarClave(p) {
  const s = String(p || '');
  if (s.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (s.length > 200) return 'La contraseña es demasiado larga.';
  if (!/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(s) || !/\d/.test(s)) return 'La contraseña debe tener letras y números.';
  return '';
}
function crearUsuario(db, { email, nombre, rol, clave, debeCambiarClave }) {
  email = limpiarCorreo(email); nombre = limpiarNombre(nombre);
  if (!correoOk(email)) throw new Error('El correo no es válido.');
  if (nombre.length < 2) throw new Error('Escribe el nombre (tal como aparece en el CRM).');
  if (!ROLES.includes(rol)) throw new Error('Rol no válido.');
  const err = validarClave(clave); if (err) throw new Error(err);
  if (db.usuarios.some((u) => u.email === email)) throw new Error('Ya existe un usuario con ese correo.');
  const u = { id: crypto.randomUUID(), email, nombre, rol, hash: bcrypt.hashSync(String(clave), COSTO_BCRYPT), activo: true, creado: ahora(), debeCambiarClave: !!debeCambiarClave };
  db.usuarios.push(u);
  return u;
}
function abrirSesion(db, u, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + SESION_DIAS * 864e5).toISOString();
  db.sesiones[huella(token)] = { uid: u.id, creado: ahora(), expira, ip: ipDe(req), agente: String(req.get('user-agent') || '').slice(0, 200) };
  u.ultimoIngreso = ahora();
  return { token, expira, usuario: publico(u) };
}
const ipDe = (req) => String(req.ip || req.get('x-forwarded-for') || '').split(',')[0].trim();
const tokenDe = (req) => { const m = String(req.get('authorization') || '').match(/^Bearer\s+([a-f0-9]{64})$/i); return m ? m[1] : ''; };

// ── Middleware: si llega un token válido, deja al usuario en req.usuario ─────
function leerSesion(req, res, next) {
  const t = tokenDe(req);
  if (t) {
    const db = leer(), s = db.sesiones[huella(t)];
    if (s && new Date(s.expira).getTime() > Date.now()) {
      const u = db.usuarios.find((x) => x.id === s.uid && x.activo !== false);
      if (u) { req.usuario = publico(u); req.sesionHuella = huella(t); }
    }
    if (!req.usuario) req.sesionInvalida = true;
  }
  next();
}
// Para rutas que exigen sesión de usuario (no la clave antigua)
const requiereUsuario = (req, res, next) => (req.usuario ? next() : res.status(401).json({ error: 'Tu sesión venció. Vuelve a entrar con tu correo y contraseña.', sesion: 'vencida' }));
const requiereAdmin = (req, res, next) => (req.usuario && req.usuario.rol === 'admin' ? next() : res.status(403).json({ error: 'Solo un administrador puede hacer esto.' }));

// ── Rutas /auth ─────────────────────────────────────────────────────────────
const router = express.Router();
// Límite de intentos de login: 5 fallidos por correo (o 20 por IP) → espera de 15 minutos
const BLOQUEO_MS = 15 * 60 * 1000;
function bloqueado(db, clave, max) { const i = db.intentos[clave]; return i && i.n >= max && Date.now() - new Date(i.ultimo).getTime() < BLOQUEO_MS; }
function fallo(db, clave) { const i = db.intentos[clave] || { n: 0 }; if (Date.now() - new Date(i.ultimo || 0).getTime() > BLOQUEO_MS) i.n = 0; i.n += 1; i.ultimo = ahora(); db.intentos[clave] = i; }

router.get('/estado', (req, res) => res.json({ hayUsuarios: hayUsuarios(), claveAntigua: claveAntiguaPermitida(), sesionDias: SESION_DIAS, usuario: req.usuario || null }));

router.post('/login', async (req, res) => {
  const email = limpiarCorreo((req.body || {}).email), clave = String((req.body || {}).clave || '');
  const r = await modificar((db) => {
    const kE = `e:${email}`, kI = `i:${ipDe(req)}`;
    if (bloqueado(db, kE, 5) || bloqueado(db, kI, 20)) return { error: 'Demasiados intentos. Espera 15 minutos y vuelve a probar.', status: 429 };
    const u = db.usuarios.find((x) => x.email === email && x.activo !== false);
    const ok = u && clave.length <= 200 && bcrypt.compareSync(clave, u.hash);
    if (!ok) { fallo(db, kE); fallo(db, kI); return { error: 'Correo o contraseña incorrectos.', status: 401 }; }
    delete db.intentos[kE];
    return abrirSesion(db, u, req);
  });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
});

// Primer administrador: solo funciona mientras no exista ningún usuario, y exige la clave actual del equipo
router.post('/primer-admin', async (req, res) => {
  const b = req.body || {};
  const claveEquipo = process.env.FB_CLAVE || process.env.CRM_KEY;
  if (!claveEquipo) return res.status(500).json({ error: 'Falta FB_CLAVE o CRM_KEY en Railway.' });
  if (String(b.claveEquipo || '') !== String(process.env.FB_CLAVE || '') && String(b.claveEquipo || '') !== String(process.env.CRM_KEY || '')) return res.status(401).json({ error: 'La clave actual del equipo no es correcta.' });
  try {
    const r = await modificar((db) => {
      if (db.usuarios.length) return { error: 'Ya hay usuarios creados. Pídele a un administrador que te cree el tuyo.' };
      const u = crearUsuario(db, { email: b.email, nombre: b.nombre, rol: 'admin', clave: b.clave });
      return abrirSesion(db, u, req);
    });
    if (r.error) return res.status(409).json(r);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/yo', requiereUsuario, (req, res) => res.json({ usuario: req.usuario }));
router.post('/logout', async (req, res) => {
  if (req.sesionHuella) await modificar((db) => { delete db.sesiones[req.sesionHuella]; });
  res.json({ ok: true });
});
router.post('/cambiar-clave', requiereUsuario, async (req, res) => {
  const b = req.body || {};
  const err = validarClave(b.nueva); if (err) return res.status(400).json({ error: err });
  const r = await modificar((db) => {
    const u = db.usuarios.find((x) => x.id === req.usuario.id); if (!u) return { error: 'Usuario no encontrado.' };
    if (!bcrypt.compareSync(String(b.actual || ''), u.hash)) return { error: 'La contraseña actual no es correcta.' };
    u.hash = bcrypt.hashSync(String(b.nueva), COSTO_BCRYPT); u.debeCambiarClave = false; u.claveCambiada = ahora();
    // Se cierran las demás sesiones de esa persona
    for (const [k, s] of Object.entries(db.sesiones)) if (s.uid === u.id && k !== req.sesionHuella) delete db.sesiones[k];
    return { ok: true, usuario: publico(u) };
  });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// Administración de usuarios (solo administradores)
router.get('/usuarios', requiereUsuario, requiereAdmin, (req, res) => res.json({ usuarios: leer().usuarios.map(publico) }));
const claveTemporal = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', n = '23456789'; let s = ''; for (let i = 0; i < 10; i++) s += (i % 3 === 2 ? n : a)[crypto.randomInt(i % 3 === 2 ? n.length : a.length)]; return s; };
router.post('/usuarios', requiereUsuario, requiereAdmin, async (req, res) => {
  const b = req.body || {};
  const temporal = b.clave ? String(b.clave) : claveTemporal();
  try {
    const u = await modificar((db) => crearUsuario(db, { email: b.email, nombre: b.nombre, rol: b.rol === 'admin' ? 'admin' : 'corredor', clave: temporal, debeCambiarClave: true }));
    res.json({ usuario: publico(u), claveTemporal: b.clave ? '' : temporal });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/usuarios/:id', requiereUsuario, requiereAdmin, async (req, res) => {
  const b = req.body || {};
  const r = await modificar((db) => {
    const u = db.usuarios.find((x) => x.id === req.params.id); if (!u) return { error: 'Usuario no encontrado.' };
    const adminsActivos = db.usuarios.filter((x) => x.rol === 'admin' && x.activo !== false);
    const quedaSinAdmin = (u.rol === 'admin' && u.activo !== false) && ((b.rol && b.rol !== 'admin') || b.activo === false) && adminsActivos.length <= 1;
    if (quedaSinAdmin) return { error: 'Debe quedar al menos un administrador activo.' };
    if (b.nombre !== undefined) { const n = limpiarNombre(b.nombre); if (n.length < 2) return { error: 'Nombre no válido.' }; u.nombre = n; }
    if (b.rol && ROLES.includes(b.rol)) u.rol = b.rol;
    if (typeof b.activo === 'boolean') { u.activo = b.activo; if (!b.activo) for (const [k, s] of Object.entries(db.sesiones)) if (s.uid === u.id) delete db.sesiones[k]; }
    let temporal = '';
    if (b.restablecer) { temporal = claveTemporal(); u.hash = bcrypt.hashSync(temporal, COSTO_BCRYPT); u.debeCambiarClave = true; for (const [k, s] of Object.entries(db.sesiones)) if (s.uid === u.id) delete db.sesiones[k]; }
    return { usuario: publico(u), claveTemporal: temporal };
  });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// ── Olvidé mi contraseña ───────────────────────────────────────────────────
// 1) Link por correo: vale 30 minutos y una sola vez.
// 2) Con la clave de administradora de Railway (CRM_ADMIN_KEY): para cuando no llega el correo.
const FRONT = String(process.env.CRM_URL || 'https://farmbrokers-frontend.vercel.app/#crm').replace(/[#?].*$/, '').replace(/\/$/, '');
const nuevaClaveDe = (db, u, nueva) => { u.hash = bcrypt.hashSync(String(nueva), COSTO_BCRYPT); u.debeCambiarClave = false; u.claveCambiada = ahora(); for (const [k, ses] of Object.entries(db.sesiones)) if (ses.uid === u.id) delete db.sesiones[k]; };
router.post('/olvide', async (req, res) => {
  const email = limpiarCorreo((req.body || {}).email);
  const r = await modificar((db) => {
    const kI = `o:${ipDe(req)}`, kE = `oe:${email}`;
    if (bloqueado(db, kI, 10) || bloqueado(db, kE, 3)) return { error: 'Ya enviamos varios links. Revisa tu correo (también en spam) o espera 15 minutos.', status: 429 };
    fallo(db, kI); fallo(db, kE);
    const u = db.usuarios.find((x) => x.email === email && x.activo !== false);
    if (!u) return { ok: true };
    const token = crypto.randomBytes(32).toString('hex');
    db.restablecer = db.restablecer || {};
    db.restablecer[huella(token)] = { uid: u.id, expira: new Date(Date.now() + 30 * 60e3).toISOString(), ip: ipDe(req) };
    return { ok: true, enviar: { u: publico(u), token } };
  });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  if (r.enviar) {
    const link = `${FRONT}/?restablecer=${r.enviar.token}#crm`;
    try {
      const crm = require('./crm.cjs')._interno;
      if (!crm.correoConfigurado()) return res.status(503).json({ error: 'El envío de correos no está configurado en el servidor. Usa la opción con la clave de administradora.' });
      await crm.enviarCorreo({ para: r.enviar.u.email, asunto: 'Crea una nueva contraseña - Farm Brokers',
        html: crm.plantillaCorreo('Crea una nueva contraseña', `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Hola ${String(r.enviar.u.nombre).replace(/</g, '&lt;')}, pediste crear una nueva contraseña para entrar al CRM de Farm Brokers.</p><p style="margin:0 0 12px"><a href="${link}" style="display:inline-block;background:#2D6A45;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:bold">Crear nueva contraseña</a></p><p style="margin:0;font-size:13px;color:#5E6E64">El link vale 30 minutos y sirve una sola vez. Si no lo pediste tú, ignora este correo.</p>`, 'Correo automático del CRM de Farm Brokers.'),
        texto: `Crea una nueva contraseña para el CRM de Farm Brokers (vale 30 minutos): ${link}` });
    } catch (e) { return res.status(502).json({ error: `No se pudo enviar el correo: ${e.message}. Usa la opción con la clave de administradora.` }); }
  }
  res.json({ ok: true, mensaje: 'Si el correo corresponde a una cuenta, te llegó un link para crear una nueva contraseña. Revisa también spam.' });
});
router.post('/restablecer', async (req, res) => {
  const b = req.body || {};
  const err = validarClave(b.nueva); if (err) return res.status(400).json({ error: err });
  const r = await modificar((db) => {
    const k = huella(String(b.token || '')), t = (db.restablecer || {})[k];
    if (!t || new Date(t.expira).getTime() < Date.now()) return { error: 'El link venció o ya se usó. Pide uno nuevo en “¿Olvidaste tu contraseña?”.' };
    const u = db.usuarios.find((x) => x.id === t.uid && x.activo !== false); if (!u) return { error: 'La cuenta no está activa.' };
    delete db.restablecer[k];
    nuevaClaveDe(db, u, b.nueva);
    return abrirSesion(db, u, req);
  });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
router.post('/recuperar-admin', async (req, res) => {
  const b = req.body || {}, clave = String(process.env.CRM_ADMIN_KEY || '');
  if (!clave) return res.status(503).json({ error: 'Falta la variable CRM_ADMIN_KEY en Railway.' });
  const err = validarClave(b.nueva); if (err) return res.status(400).json({ error: err });
  const email = limpiarCorreo(b.email);
  const r = await modificar((db) => {
    const kI = `ra:${ipDe(req)}`;
    if (bloqueado(db, kI, 5)) return { error: 'Demasiados intentos. Espera 15 minutos.', status: 429 };
    const dada = Buffer.from(String(b.claveAdmin || '')), real = Buffer.from(clave);
    if (dada.length !== real.length || !crypto.timingSafeEqual(dada, real)) { fallo(db, kI); return { error: 'La clave de administradora no es correcta (es la variable CRM_ADMIN_KEY de Railway).', status: 401 }; }
    const u = db.usuarios.find((x) => x.email === email && x.activo !== false);
    if (!u) { fallo(db, kI); return { error: 'No hay una cuenta activa con ese correo.', status: 404 }; }
    delete db.intentos[kI]; delete db.intentos[`e:${email}`];
    nuevaClaveDe(db, u, b.nueva);
    return abrirSesion(db, u, req);
  });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
});

module.exports = { router, leerSesion, requiereUsuario, requiereAdmin, claveAntiguaPermitida, hayUsuarios, _interno: { leer, modificar, crearUsuario, validarClave, ARCHIVO } };
