// Protección del servidor: orígenes permitidos (CORS), límite de peticiones y validación de datos de entrada.
// Todo en memoria: si el servidor se reinicia, los contadores parten de cero (no se pierde ningún dato).
const cors = require('cors');

// ── CORS: solo las páginas de Farm Brokers pueden llamar al servidor desde el navegador ──
const ORIGENES_BASE = ['https://farmbrokers-frontend.vercel.app', 'https://farmbrokers.cl', 'https://www.farmbrokers.cl', 'https://vende.farmbrokers.cl', 'https://fichas.farmbrokers.cl'];
const ORIGENES = [...new Set([...ORIGENES_BASE, ...String(process.env.CORS_ORIGENES || '').split(',')].map((s) => s.trim().replace(/\/$/, '')).filter(Boolean))];
const PREVISTAS = /^https:\/\/farmbrokers-frontend-[a-z0-9-]+\.vercel\.app$/; // versiones de prueba de Vercel
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const permitirLocal = () => process.env.CORS_LOCAL === '1';
const DOMINIO_PROPIO = /^https:\/\/([a-z0-9-]+\.)*farmbrokers\.cl$/; // farmbrokers.cl y cualquier subdominio (vende., fichas., …)
const todos = () => ORIGENES.includes('*'); // CORS_ORIGENES=* desactiva la restricción (solo para emergencias)
const rechazados = new Set();
function origenPermitido(o) {
  if (!o) return true; // sin Origin: enlaces abiertos directo, imágenes, el propio servidor, otros servidores
  if (todos() || ORIGENES.includes(o) || PREVISTAS.test(o) || DOMINIO_PROPIO.test(o)) return true;
  if (permitirLocal() && LOCAL.test(o)) return true;
  if (!rechazados.has(o) && rechazados.size < 200) { rechazados.add(o); console.warn(`[CORS] Origen rechazado: ${o} (si es una página de Farm Brokers, agrégalo en la variable CORS_ORIGENES)`); }
  return false;
}
const corsMw = cors({ origin: (o, cb) => cb(null, origenPermitido(o)), maxAge: 86400 });
function soloOrigenesPermitidos(req, res, next) {
  const o = req.get('origin');
  if (origenPermitido(o)) return next();
  // Imágenes públicas (las usan los PDF y el brochure): se pueden mostrar desde cualquier parte
  if (req.method === 'GET' && req.path === '/api/crm/publico-img') return next();
  return res.status(403).json({ error: 'Origen no permitido.' });
}

// ── Límite de peticiones ──
const cubetas = new Map(); // clave → { n, desde }
setInterval(() => { const t = Date.now(); for (const [k, v] of cubetas) if (t - v.desde > v.ventana) cubetas.delete(k); }, 60 * 1000).unref();
const ipDe = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || 'sin-ip');
const quien = (req) => (req.usuario ? `u:${req.usuario.id}` : `ip:${ipDe(req)}`);
function contar(clave, ventana, max) {
  const t = Date.now();
  let c = cubetas.get(clave);
  if (!c || t - c.desde > ventana) { c = { n: 0, desde: t, ventana }; cubetas.set(clave, c); }
  c.n += 1;
  return c.n > max ? Math.ceil((c.desde + ventana - t) / 1000) : 0;
}
function limitar(nombre, { ventanaMin, max, clave = quien, mensaje }) {
  const ventana = ventanaMin * 60 * 1000;
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const espera = contar(`${nombre}|${clave(req)}`, ventana, max);
    if (!espera) return next();
    res.set('Retry-After', String(espera));
    return res.status(429).json({ error: mensaje || `Demasiadas solicitudes seguidas. Espera ${espera > 90 ? `${Math.ceil(espera / 60)} minutos` : `${espera} segundos`} y vuelve a intentar.`, limite: nombre, espera });
  };
}
// Claves equivocadas repetidas desde una misma IP (cualquier respuesta 401): 30 en 15 minutos → espera
const fallosClave = new Map();
function frenoClaves(req, res, next) {
  if (req.usuario) return next(); // quien ya entró con su cuenta no queda bloqueado por errores de otros en la misma red
  const ip = ipDe(req), t = Date.now(), f = fallosClave.get(ip);
  if (f && f.n >= 30 && t - f.desde < 15 * 60 * 1000) return res.status(429).json({ error: 'Demasiados intentos con clave incorrecta. Espera 15 minutos.' });
  res.on('finish', () => {
    if (res.statusCode !== 401) return;
    const g = fallosClave.get(ip);
    if (!g || Date.now() - g.desde > 15 * 60 * 1000) fallosClave.set(ip, { n: 1, desde: Date.now() }); else g.n += 1;
  });
  next();
}
setInterval(() => { const t = Date.now(); for (const [k, v] of fallosClave) if (t - v.desde > 15 * 60 * 1000) fallosClave.delete(k); }, 5 * 60 * 1000).unref();

// Rutas que consultan fuentes externas (SII, CIREN, SITRURAL, DGA, IA…): cuestan cuota y tiempo
const RUTAS_EXTERNAS = ['/buscar-propietario', '/consultar-inia', '/energia-cercana', '/consultar-normativa-solar', '/buscar-comparables', '/buscar-rol', '/suelos-rol', '/poligono-catastral',
  '/distancias', '/deslindes', '/derechos-agua', '/leyenda-ciren', '/img-sitrural', '/escasez', '/sitrural-recargar', '/diag-sitrural', '/diag-dga', '/mapa-satelital'];
const RUTAS_IA = ['/generar-informe', '/generar-word'];
const N = (v, d) => (Number(v) > 0 ? Number(v) : d);

// Va antes de leer el cuerpo de la petición, para que incluso los errores lleven los encabezados CORS
function instalarCors(app) {
  app.use(corsMw);
  app.use(soloOrigenesPermitidos);
}
function instalar(app) {
  app.use(frenoClaves);
  // General: cualquier ruta (el CRM se actualiza solo cada minuto y carga fotos: el límite es holgado)
  app.use(limitar('general', { ventanaMin: 5, max: N(process.env.LIMITE_GENERAL, 2000) }));
  app.use('/auth/login', limitar('login', { ventanaMin: 15, max: 30, clave: ipDe, mensaje: 'Demasiados intentos de ingreso. Espera 15 minutos.' }));
  app.use('/auth/primer-admin', limitar('primer-admin', { ventanaMin: 60, max: 10, clave: ipDe }));
  app.use(RUTAS_EXTERNAS, limitar('fuentes', { ventanaMin: 10, max: N(process.env.LIMITE_FUENTES, 200), mensaje: 'Se hicieron demasiadas consultas a fuentes externas (SII, CIREN, DGA…) en poco rato. Espera unos minutos y vuelve a intentar.' }));
  app.use(RUTAS_IA, limitar('ia', { ventanaMin: 10, max: N(process.env.LIMITE_IA, 30), mensaje: 'Se generaron demasiados informes seguidos. Espera unos minutos y vuelve a intentar.' }));
  // Páginas públicas (links que reciben clientes y propietarios): por IP
  app.use('/api/crm/publico-img', limitar('publico-img', { ventanaMin: 10, max: 1500, clave: ipDe }));
  app.use(['/api/crm/publico', '/api/crm/publico-plano', '/api/crm/publico-orden', '/api/crm/publico-ficha', '/api/crm/publico-brochure', '/f', '/b'], limitar('publico', { ventanaMin: 10, max: 400, clave: ipDe }));
  app.post('/api/crm/publico-vende', limitar('vende', { ventanaMin: 60, max: 8, clave: ipDe, mensaje: 'Ya recibimos varios formularios desde tu conexión. Si necesitas enviar otro, espera un rato o escríbenos a contacto@farmbrokers.cl.' }));
  app.post(/^\/api\/crm\/publico[^/]*\/[^/]+\/(firmar|aceptar|mandato|archivo|kmz)/, limitar('publico-envios', { ventanaMin: 60, max: 60, clave: ipDe }));
  app.use(validarEntrada);
}

// ── Validación de datos de entrada (rutas de la plataforma de tasaciones) ──
// Solo revisa los campos que vienen: si falta alguno, cada ruta responde su propio mensaje como antes.
const texto = (max) => (v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= max;
const numero = (min, max) => (v) => v === '' || (v !== null && typeof v !== 'object' && typeof v !== 'boolean' && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max);
const REGLAS = {
  rol: [texto(40), 'El rol no es válido.'],
  comuna: [texto(80), 'La comuna no es válida.'],
  region: [texto(80), 'La región no es válida.'],
  provincia: [texto(80), 'La provincia no es válida.'],
  cultivo: [texto(200), 'El cultivo no es válido.'],
  claseSuelo: [texto(300), 'La clase de suelo no es válida.'],
  servicio: [texto(80), 'Servicio no válido.'],
  capaId: [texto(80), 'Capa no válida.'],
  capaPredioId: [texto(80), 'Capa no válida.'],
  lat: [numero(-90, 90), 'La latitud no es válida.'],
  lon: [numero(-180, 180), 'La longitud no es válida.'],
  superficieObjetivo: [numero(0, 1e7), 'La superficie no es válida.'],
  id: [(v) => typeof v === 'string' && v.length <= 200 && !/[\\/]|\.\./.test(v), 'Identificador no válido.'],
  nombre: [texto(400), 'El nombre es demasiado largo.'],
  datos: [(v) => v && typeof v === 'object' && !Array.isArray(v), 'Los datos de la tasación no son válidos.'],
  bbox: [(v) => Array.isArray(v) && v.length === 4 && v.every((x) => Number.isFinite(Number(x))), 'El área del mapa no es válida.'],
  u: [(v) => typeof v === 'string' && v.length <= 3000 && /^https?:\/\//i.test(v), 'Dirección de imagen no válida.'],
};
function validarEntrada(req, res, next) {
  if (req.path.startsWith('/api/crm') || req.path.startsWith('/auth') || RUTAS_IA.includes(req.path) || req.method === 'OPTIONS') return next(); // el CRM y el ingreso validan cada dato en su propio código
  if (req.body !== undefined && req.body !== null && (typeof req.body !== 'object')) return res.status(400).json({ error: 'Formato de datos no válido.' });
  for (const fuente of [req.body || {}, req.query || {}]) {
    if (Array.isArray(fuente)) return res.status(400).json({ error: 'Formato de datos no válido.' });
    for (const [k, [ok, msg]] of Object.entries(REGLAS)) {
      if (fuente[k] === undefined || fuente[k] === null) continue;
      if (fuente === req.query && k === 'u' && typeof fuente[k] === 'string' && !fuente[k]) continue;
      if (!ok(fuente[k])) return res.status(400).json({ error: msg, campo: k });
    }
  }
  next();
}

module.exports = { instalar, instalarCors, origenPermitido, _interno: { cubetas, fallosClave, REGLAS } };
