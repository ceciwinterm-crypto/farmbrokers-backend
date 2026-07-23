// Servidor backend para Farm Brokers - Plataforma de Tasaciones

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SIMPLEAPI_KEY = process.env.SIMPLEAPI_KEY;
const SIMPLEAPI_URL = process.env.SIMPLEAPI_URL; // opcional: fija la ruta exacta
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) console.error('ERROR: Falta ANTHROPIC_API_KEY');
if (!SIMPLEAPI_KEY) console.warn('AVISO: Falta SIMPLEAPI_KEY (la busqueda por rol no funcionara)');

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API v52', simpleapi: !!SIMPLEAPI_KEY });
});

// ─────────────────────────── GENERAR INFORME (IA) ───────────────────────────
app.post('/generar-informe', async (req, res) => {
  try {
    const datos = req.body;
    if (!datos.predioNombre) return res.status(400).json({ error: 'Falta el nombre del predio' });

    const instruccion = `Eres tasador agricola experto de Farm Brokers Chile. Con los datos del predio a continuacion, redacta textos profesionales en espanol para un Informe de Tasacion.

DATOS DEL PREDIO:
PREDIO: ${datos.predioNombre}
ROLES SII DEL PREDIO (${(datos.roles || []).length} rol(es) — el predio es el CONJUNTO de todos): ${(datos.roles || []).map(r => r.rol + ' de ' + (r.comuna||'') + ((r.datos&&r.datos.nombrePano)?' ("' + r.datos.nombrePano + '")':'') + ((r.datos&&r.datos.superfSII)?', ' + r.datos.superfSII + ' ha SII':'') + ((r.datos&&r.datos.avaluoFiscal)?', avaluo $' + r.datos.avaluoFiscal:'') + ((r.datos&&r.datos.noAgricola)?' [ROL NO AGRICOLA: urbano u otro destino, sin analisis de suelos]':'')).join(' | ')}
COMUNA: ${datos.roles?.[0]?.comuna || ''} | PROVINCIA: ${datos.provincia} | REGION: ${datos.region}
LOCALIDAD: ${datos.localidad}
PROPIETARIO: ${(datos.roles || []).map(r => r.datos?.propietario).filter(Boolean).join(', ')}
AVALUO TOTAL: $${datos.avaluoTotal || 0} | UF BASE: ${datos.ufBase}
SUPERFICIES: Titulos ${datos.superfTitulos} ha, SII ${datos.superfSIITotal} ha, Google Earth ${datos.superfGoogleEarth} ha
SUELOS: ${datos.suelosDetalle || ("Clase I " + datos.c1 + " ha, II " + datos.c2 + " ha, III " + datos.c3 + " ha, IV " + datos.c4 + " ha")}
SERIE: ${datos.seriesSuelo} | PENDIENTE: ${datos.pendiente} | DRENAJE: ${datos.drenaje}
PLANTACIONES FRUTALES (catastro CIREN): ${datos.plantacionesTxt || "sin plantaciones registradas en el catastro fruticola"}
AGUA: ${datos.recursosHidricosTxt || (datos.cn1 ? datos.cn1 + ' (' + datos.ca1 + ' acciones, ' + datos.cq1 + ' l/s)' : 'sin derechos de agua informados')}
PLANTACIONES: ${datos.plantacionDesc} (${datos.plantacionHas} ha)
CONSTRUCCIONES: ${datos.construcciones}
COORDENADAS: ${datos.coordLat} S, ${datos.coordLon} O | DISTANCIA SANTIAGO: ${datos.distSantiago} km | DISTANCIA CENTRO COMUNAL: ${datos.distComuna || "no informada"}
ACCESO: ${datos.acceso}
ALTITUD: ${datos.altitud || "no informada"} m.s.n.m. | DATOS CLIMATICOS MEDIDOS: ${datos.climaTxt || "sin datos medidos"}
USO ACTUAL DEL SUELO (CONAF): ${datos.usosResumen || "sin datos"}
INSTRUCCIONES DEL TASADOR PARA LAS CONCLUSIONES: ${datos.guiaConclusion || "ninguna"}
ZONA DE ESCASEZ HIDRICA: ${datos.escasezTxt || "sin decreto vigente detectado"}

Responde UNICAMENTE con un objeto JSON valido (sin markdown, sin bloques de codigo, sin texto antes ni despues), con exactamente estos 10 campos de texto:
- resumen: 2-3 oraciones breves describiendo el predio, ubicacion y uso actual. Si son varios roles, describe el predio como una unidad compuesta por esos paños
- ubicacion: 1-2 oraciones con coordenadas, distancia a Santiago y acceso
- titulos: 1 parrafo breve sobre inscripcion y deslindes
- topografia: 2 oraciones estimando la composicion del relieve en porcentajes aproximados a partir de las clases de suelo (Clases I a III = sectores planos; IV = lomajes suaves; VI = laderas; VII y VIII = cerros y quebradas). Estilo: "Predio compuesto en un 80% por cerros y quebradas, un 13% por laderas y un 7% por sectores de lomaje suave."
- suelos: 1 parrafo breve sobre clasificacion de suelos segun SII
- ciren: 1 parrafo breve con caracteristicas de la serie de suelo
- usoActual: 2 oraciones breves describiendo la composicion del uso actual del suelo segun el catastro CONAF (que uso domina, que implica para el predio)
- clima: 1 parrafo sobre el clima de la zona. Si hay DATOS CLIMATICOS medidos, usalos como base (cifras reales del punto del predio) en vez de generalidades
- hidrico: 1 parrafo breve sobre derechos de aprovechamiento de aguas. NUNCA menciones valores monetarios de los derechos (esos van solo en la tabla de valorizacion). Si la zona esta bajo decreto de escasez hidrica, menciona la advertencia y la necesidad de monitorear caudales
- conclusiones: 2 parrafos breves de conclusiones profesionales de tasacion. Si el predio tiene VARIOS roles, la conclusion SIEMPRE abarca el conjunto completo (superficie total, plantaciones de todos los paños) y menciona cada rol con su nombre de paño si existe. Si hay INSTRUCCIONES DEL TASADOR, siguelas estrictamente como enfoque principal de la conclusion

Manten cada campo conciso. El JSON completo debe ser valido y estar bien cerrado.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        messages: [{ role: 'user', content: instruccion }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Error de la API de Claude', detail: errText });
    }

    const data = await response.json();
    const text = (data.content || []).map(c => c.text || '').join('').trim();
    console.log('Respuesta IA (500 chars):', text.substring(0, 500));

    const match = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim().match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Respuesta de IA no contenia JSON valido', raw: text.substring(0, 1000) });

    let ia;
    try { ia = JSON.parse(match[0]); }
    catch (e) { return res.status(500).json({ error: 'JSON de IA mal formado: ' + e.message, raw: match[0].substring(0, 1000) }); }

    res.json({ ia });
  } catch (err) {
    console.error('Error en /generar-informe:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────── BUSQUEDA POR ROL VIA SIMPLEAPI (Mapas SII) ────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function intentar(url, opts, debug, label) {
  try {
    const r = await fetch(url, opts);
    const body = await r.text();
    debug.push({ label, url, metodo: opts.method || 'GET', status: r.status, snippet: body.substring(0, 800) });
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    if (json && typeof json === 'object') { json.__status = r.status; return json; }
    return null;
  } catch (e) {
    debug.push({ label, url, error: e.message });
    return null;
  }
}

// Cache en memoria de la lista de comunas de SimpleAPI (evita gastar consultas)
const cacheComunas = { lista: null };
const cacheBusquedas = {}; // resultados de buscar-rol por rol+comuna (24 h) para ahorrar cuota SimpleAPI

app.post('/buscar-rol', async (req, res) => {
  const { rol, comuna } = req.body || {};
  if (!rol || !comuna) return res.status(400).json({ ok: false, error: 'Faltan rol y comuna' });
  if (!SIMPLEAPI_KEY) return res.json({ ok: false, error: 'Falta configurar SIMPLEAPI_KEY en Railway (Variables)' });

  const debug = [];
  const headers = { 'Authorization': SIMPLEAPI_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const rolLimpio = String(rol).trim();
  const comunaLimpia = String(comuna).trim();

  // Cache: si este rol+comuna ya se consulto con exito en las ultimas 24 h, no gastar cuota
  const claveCache = (rolLimpio + '|' + comunaLimpia).toLowerCase();
  const enCache = cacheBusquedas[claveCache];
  if (enCache && (Date.now() - enCache.t) < 24 * 3600 * 1000) {
    return res.json({ ...enCache.respuesta, cache: true });
  }

  const BASE = 'https://servicios.simpleapi.cl/api/mapas';
  const URL = SIMPLEAPI_URL || (BASE + '/buscar/rol');

  const partes = rolLimpio.split('-').map(s => s.trim());
  const manzana = partes[0] || '';
  const predio = partes[1] || '';

  const norm = s => (s || '').toString().trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Detecta el error transitorio del scraper de SimpleAPI contra el SII
  const esErrorComunas = (r) => {
    if (!r) return false;
    const msg = JSON.stringify(r).toLowerCase();
    return r.__status >= 400 && msg.includes('error al obtener comunas');
  };

  let resultado = null;
  let listaComunas = cacheComunas.lista;

  // ── Paso 1: intento directo con reintentos ──
  // "Error al obtener comunas" = fallo transitorio del lado de SimpleAPI/SII.
  // Reintentamos hasta 3 veces con pausa (respetando el limite de 5 consultas/min).
  const bodyDirecto = JSON.stringify({ comuna: comunaLimpia, manzana, predio });
  for (let intento = 1; intento <= 2 && !resultado; intento++) {
    const r = await intentar(URL, { method: 'POST', headers, body: bodyDirecto }, debug, 'POST directo (intento ' + intento + ')');
    if (r && r.__status === 200) { resultado = r; break; }
    if (r && Array.isArray(r.data) && r.data.some(x => x.Comuna || x.comuna)) {
      listaComunas = r.data; cacheComunas.lista = listaComunas;
      break; // nos devolvio alternativas de comuna: pasamos a resolverla
    }
    if (r && (r.__status === 503 || /under construction/i.test(JSON.stringify(r)))) {
      return res.json({ ok: false, mensaje: '🔧 El servicio de SimpleAPI esta caido en este momento (su servidor muestra "Site Under Construction"). No es un problema de tu plataforma ni de tu cuota. Reintenta en un rato, o usa los botones manuales Avaluo SII / Mapa SII.', debug });
    }
    if (esErrorComunas(r)) { await sleep(4000); continue; } // transitorio: esperar y reintentar
    if (r && r.__status === 401) {
      const cuerpo = JSON.stringify(r).toLowerCase();
      const esCuota = cuerpo.includes('l\u00edmite') || cuerpo.includes('limite');
      return res.json({ ok: false, mensaje: esCuota
        ? 'SimpleAPI: limite de consultas alcanzado en tu plan (modulo Mapas). Espera unos minutos y reintenta; si persiste, revisa el saldo/plan de tu cuenta en simpleapi.cl. Mientras, usa los botones manuales Avaluo SII / Mapa SII.'
        : 'SimpleAPI rechazo la API key (401). Revisa SIMPLEAPI_KEY en Railway.', debug });
    }
    break; // otro tipo de error: no insistir por la misma via
  }

  // ── Paso 3: resolver la comuna con el catalogo y buscar con el nombre/Id exacto ──
  if (!resultado && Array.isArray(listaComunas)) {
    const objetivo = norm(comunaLimpia);
    const found = listaComunas.find(x => norm(x.Comuna || x.comuna || x.Nombre || x.nombre) === objetivo)
               || listaComunas.find(x => norm(x.Comuna || x.comuna || x.Nombre || x.nombre).includes(objetivo));
    const comunaId = found && (found.Id || found.id || found.ID || found.Codigo || found.codigo);
    const comunaNombre = found && (found.Comuna || found.comuna || found.Nombre || found.nombre);
    debug.push({ label: 'comuna-resuelta', comunaId: comunaId || 'NO ENCONTRADA', comunaNombre: comunaNombre || '-', buscado: objetivo, totalComunas: listaComunas.length });

    const bodies = [];
    if (comunaNombre) bodies.push({ comuna: comunaNombre, manzana, predio });
    if (comunaId !== undefined && comunaId !== null) bodies.push({ comuna: comunaId, manzana, predio });
    for (const b of bodies) {
      await sleep(2000);
      const r = await intentar(URL, { method: 'POST', headers, body: JSON.stringify(b) }, debug, 'POST ' + JSON.stringify(b));
      if (r && r.__status === 200) { resultado = r; break; }
    }
  }

  if (!resultado) {
    const huboTransitorio = debug.some(d => (d.snippet || '').toLowerCase().includes('error al obtener comunas'));
    const mensaje = huboTransitorio
      ? 'SimpleAPI no logro consultar el SII en este momento (fallo temporal de su lado). Espera 1-2 minutos y vuelve a intentar. Si persiste, usa los botones manuales.'
      : 'Ninguna ruta respondio con datos. Revisa el detalle.';
    return res.json({ ok: false, mensaje, debug });
  }

  // Mapeo flexible de campos (nombres reales confirmados de SimpleAPI Mapas)
  const cand = (resultado && (resultado.Datos || resultado.datos)) || (Array.isArray(resultado) ? resultado[0] : (resultado.data || resultado.predio || resultado.resultado || resultado));
  const g = (o, ...keys) => { for (const k of keys) { if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; } return ''; };

  const datosMap = {
    avaluoFiscal: String(g(cand, 'ValorTotal', 'avaluo', 'avaluoTotal', 'avaluoFiscal')),
    avaluoAfecto: String(g(cand, 'ValorAfecto')),
    avaluoExento: String(g(cand, 'ValorExento')),
    superficie: String(g(cand, 'SuperficieTerreno', 'superficie', 'superficieTerreno')),
    unidad: String(g(cand, 'UnidadMedida')),
    destino: String(g(cand, 'Destino', 'destino', 'uso')),
    direccion: String(g(cand, 'Direccion', 'direccion')),
    periodo: String(g(cand, 'Periodo', 'periodo')),
    areaHomogenea: String(g(cand, 'AreaHomogenea', 'areaHomogenea', 'AH')).trim(),
    reavaluo: String(g(cand, 'Reavalúo', 'Reavaluo', 'reavaluo')),
    ubicacionTipo: String(g(cand, 'Ubicación', 'Ubicacion', 'ubicacion')),
    lat: String(g(cand, 'PosicionX', 'lat', 'latitud')),
    lon: String(g(cand, 'PosicionY', 'lng', 'lon', 'longitud'))
  };

  console.log('SimpleAPI respuesta completa:', JSON.stringify(cand).substring(0, 2000));

  const vacio = !datosMap.avaluoFiscal && !datosMap.superficie && !datosMap.destino && !datosMap.lat;
  if (vacio) {
    debug.push({ label: 'RESPUESTA-COMPLETA (enviar a Claude para mapear campos)', respuesta: cand });
    return res.json({ ok: false, mensaje: 'El rol se encontro, pero los nombres de campos son distintos. Envia el detalle a Claude.', debug });
  }

  const respuestaOk = { ok: true, datos: datosMap, raw: cand, debug };
  cacheBusquedas[claveCache] = { t: Date.now(), respuesta: respuestaOk };
  res.json(respuestaOk);
});


// ──────── SUELOS AUTOMATICOS: CIREN Propiedades Rurales + Estudio Agrologico ────────
const turf = require('@turf/turf');
const XLSX = require('xlsx');
const proj4 = require('proj4');

const CIREN_BASE = 'https://esri.ciren.cl/server/rest/services';
const CAPAS_REGION = [
  { id: 0, kw: ['ARICA'] }, { id: 1, kw: ['TARAPAC'] }, { id: 2, kw: ['ATACAMA'] },
  { id: 3, kw: ['COQUIMBO'] }, { id: 4, kw: ['VALPARA'] }, { id: 5, kw: ['METROPOLITANA'] },
  { id: 6, kw: ['HIGGINS', 'LIBERTADOR'] }, { id: 7, kw: ['MAULE'] }, { id: 8, kw: ['UBLE'] },
  { id: 9, kw: ['BIOB'] }, { id: 10, kw: ['ARAUCAN'] }, { id: 11, kw: ['RIOS', 'RÍOS'] },
  { id: 12, kw: ['LAGOS'] }, { id: 13, kw: ['AYS'] }
];
const cacheSuelosCapas = { lista: null };
const cacheMetaSuelos = {}; // metadata (alias y dominios) por capa de suelos
const cacheSitrural = { capas: null }; // capas de suelos del geoservidor de SIT Rural
const cacheUso = { svc: null, capas: null };

const normU = s => (s || '').toString().replace(/[\u00a0\u2007\u202f]/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function claseDesdeTexto(v){
  const t = normU(v).trim();
  const m = t.match(/^(VIII|VII|VI|V|IV|III|II|I)/);
  if (m) return m[1];
  const n = t.match(/^([1-8])/);
  if (n) return ['I','II','III','IV','V','VI','VII','VIII'][parseInt(n[1])-1];
  return null;
}

const manejadorSuelos = async (req, res) => {
  const { rol, comuna, region } = Object.keys(req.body || {}).length ? req.body : (req.query || {});
  if (!rol || !comuna) return res.status(400).json({ ok:false, error:'Faltan rol y comuna' });

  const debug = [];
  try {
    // 1) Capa regional de propiedades rurales
    const regionU = normU(region || '');
    const capa = CAPAS_REGION.find(cr => cr.kw.some(k => regionU.includes(k)));
    if (!capa) return res.json({ ok:false, mensaje:'No pude identificar la region "' + region + '". Completa la region en el formulario.', debug });

    // 2) Poligono del predio por rol + comuna
    const rolLimpio = String(rol).trim();
    const where = encodeURIComponent("rol='" + rolLimpio + "' AND UPPER(desccomu) LIKE '%" + normU(comuna) + "%'");
    const urlPredio = CIREN_BASE + '/IDEMINAGRI/PROPIEDADES_RURALES/MapServer/' + capa.id +
      '/query?where=' + where + '&outFields=*&returnGeometry=true&outSR=4326&f=geojson';
    const rp = await fetch(urlPredio);
    const gj = await rp.json();
    debug.push({ paso:'predio', url: urlPredio, status: rp.status, features: (gj.features||[]).length });

    if (!gj.features || !gj.features.length) {
      // reintento sin filtro de comuna
      const url2 = CIREN_BASE + '/IDEMINAGRI/PROPIEDADES_RURALES/MapServer/' + capa.id +
        "/query?where=" + encodeURIComponent("rol='" + rolLimpio + "'") + '&outFields=*&returnGeometry=true&outSR=4326&f=geojson';
      const rp2 = await fetch(url2);
      const gj2 = await rp2.json();
      debug.push({ paso:'predio-sin-comuna', status: rp2.status, features: (gj2.features||[]).length });
      if (gj2.features && gj2.features.length) {
        // Seguridad: verificar que el rol encontrado sea realmente de la comuna solicitada.
        // Los numeros de rol se repiten entre comunas: analizar otro campo en silencio es inaceptable.
        const comEncontrada = String((gj2.features[0].properties || {}).desccomu || '').trim();
        const calza = normU(comEncontrada).includes(normU(comuna)) || normU(comuna).includes(normU(comEncontrada));
        if (!calza) {
          return res.json({ ok:false,
            mensaje:'⚠ El rol ' + rolLimpio + ' NO aparece en el catastro RURAL de ' + comuna + ' (existe un rol ' + rolLimpio + ' rural, pero en la comuna de ' + comEncontrada + '). Posibles causas: (1) el rol es URBANO — verifica en SII Mapas si dice Ubicacion: Urbana, en cuyo caso no corresponde a esta plataforma de predios agricolas; (2) el numero de rol o la comuna estan mal escritos.',
            comunaEncontrada: comEncontrada, debug });
        }
        gj.features = gj2.features;
      }
      else return res.json({ ok:true, noAgricola:true,
        mensaje:'El rol ' + rolLimpio + ' no aparece en el catastro rural CIREN: se informa como NO AGRICOLA (propiedad urbana u otro destino). Sus demas antecedentes (avaluo, superficie, inscripciones) se incluyen normalmente en el informe.',
        superficieHa:'0', superficieSII:null, clases:{}, serie:'', usos:{}, plantaciones:null, fruticolaNota:'', capaFruticola:null,
        caracteristicas:{}, camposDominante:null, capacidadUso:'NO AGRICOLA', notaClases:'', bbox:null, capaSueloId:null, capaPredioId:null,
        fuente:'CIREN - IDE Minagri (referencial)', debug });
    }

    // Superficie SII registrada en el catastro (campo tipo "superfirea" del rol)
    const propsRol = gj.features[0].properties || {};
    const kSup = Object.keys(propsRol).find(k => /SUPERF/i.test(k) && propsRol[k] !== null && String(propsRol[k]).trim() !== '');
    const superficieSII = kSup ? (parseFloat(String(propsRol[kSup]).replace(',', '.')) || null) : null;
    debug.push({ paso:'superficie-sii', campo: kSup || 'no encontrado', valor: superficieSII });

    let predio = gj.features[0];
    if (gj.features.length > 1) {
      // El rol puede venir en varias partes (paños separados): se unen todas para el analisis
      try {
        for (let fi = 1; fi < gj.features.length; fi++) {
          const u = turf.union(turf.featureCollection([predio, gj.features[fi]]));
          if (u) predio = u;
        }
        debug.push({ paso:'predio-multipartes', partes: gj.features.length, nota:'El rol viene en varias partes; se analizan todas unidas.' });
      } catch (e) { debug.push({ paso:'predio-union-error', error: e.message }); }
    }
    const superficieHa = turf.area(predio) / 10000;

    // 3) Capas del estudio agrologico (cache)
    if (!cacheSuelosCapas.lista) {
      const rs = await fetch(CIREN_BASE + '/ESTUDIO_AGROLOGICO_SUELOS/MapServer?f=json');
      const js = await rs.json();
      cacheSuelosCapas.lista = js.layers || [];
      debug.push({ paso:'capas-suelos', total: cacheSuelosCapas.lista.length, nombres: cacheSuelosCapas.lista.map(l=>l.name).slice(0,20) });
    }
    let capaSuelo = cacheSuelosCapas.lista.find(l => capa.kw.some(k => normU(l.name).includes(k)));
    if (!capaSuelo && cacheSuelosCapas.lista.length === 1) capaSuelo = cacheSuelosCapas.lista[0];
    if (!capaSuelo) return res.json({ ok:false, mensaje:'No encontre capa de suelos para la region. Superficie CIREN del predio: ' + superficieHa.toFixed(2) + ' ha.', superficieHa: superficieHa.toFixed(2), debug });

    // 4) Suelos que intersectan el predio (bbox del predio como filtro espacial)
    const bb = turf.bbox(predio);
    const urlSuelos = CIREN_BASE + '/ESTUDIO_AGROLOGICO_SUELOS/MapServer/' + capaSuelo.id +
      '/query?geometry=' + bb.join(',') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=geojson';
    const rsu = await fetch(urlSuelos);
    const gsu = await rsu.json();
    debug.push({ paso:'suelos', capa: capaSuelo.name, id: capaSuelo.id, status: rsu.status, features: (gsu.features||[]).length,
      camposEjemplo: gsu.features && gsu.features[0] ? Object.keys(gsu.features[0].properties||{}) : [] });

    if (!gsu.features || !gsu.features.length) {
      return res.json({ ok:true, superficieHa: superficieHa.toFixed(2), clases:{}, serie:'', mensaje:'Poligono encontrado (superficie CIREN) pero sin datos de suelo en la capa. Completa clases manualmente.', debug });
    }

    // 5) Detectar campo de clase y de serie
    const props0 = gsu.features[0].properties || {};
    const claveClase = Object.keys(props0).find(k => /capac|cus|clase|us[oe]?$/i.test(k) && claseDesdeTexto(props0[k])) ||
                       Object.keys(props0).find(k => claseDesdeTexto(props0[k]));
    const claveSerie = Object.keys(props0).find(k => /serie|nomserie|asociaci/i.test(k));
    debug.push({ paso:'campos', claveClase, claveSerie });

    // 6) Interseccion y hectareas por clase + lista de poligonos ordenada por superficie
    const clases = {};
    let serie = '';
    const intersecciones = [];
    for (const f of gsu.features) {
      try {
        const inter = turf.intersect(turf.featureCollection([predio, f]));
        if (!inter) continue;
        const ha = turf.area(inter) / 10000;
        if (ha < 0.005) continue;
        intersecciones.push({ f, ha });
        const clase = claveClase ? claseDesdeTexto(f.properties[claveClase]) : null;
        if (clase) clases[clase] = (clases[clase] || 0) + ha;
        if (!serie && claveSerie && f.properties[claveSerie]) serie = String(f.properties[claveSerie]);
      } catch(e) { debug.push({ paso:'interseccion-error', error: e.message }); }
    }
    intersecciones.sort((a, b) => b.ha - a.ha);
    const dominante = intersecciones.length ? intersecciones[0].f : null;
    const dominanteHa = intersecciones.length ? intersecciones[0].ha : 0;

    // 6b) Caracteristicas del suelo (v2): busca por NOMBRE y ALIAS de campo,
    // y traduce codigos usando los dominios oficiales de la capa CIREN (sin inventar valores)
    const caracteristicas = {};
    let camposDominante = null;
    try {
      if (!cacheMetaSuelos[capaSuelo.id]) {
        const rm = await fetch(CIREN_BASE + '/ESTUDIO_AGROLOGICO_SUELOS/MapServer/' + capaSuelo.id + '?f=json');
        const jm = await rm.json();
        cacheMetaSuelos[capaSuelo.id] = jm.fields || [];
      }
      const fields = cacheMetaSuelos[capaSuelo.id];
      debug.push({ paso:'meta-capa', totalCampos: fields.length, campos: fields.map(f => f.name + (f.alias && f.alias !== f.name ? ' (' + f.alias + ')' : '')).slice(0, 40) });
      const metaDe = {};
      for (const fm of fields) metaDe[fm.name] = fm;

      // Traduce codigo -> descripcion oficial si el campo tiene dominio de valores en CIREN
      const decodificar = (nombreCampo, valor) => {
        const fm = metaDe[nombreCampo];
        if (fm && fm.domain && Array.isArray(fm.domain.codedValues)) {
          const cv = fm.domain.codedValues.find(cc => String(cc.code) === String(valor));
          if (cv) return String(cv.name);
        }
        return String(valor).trim();
      };

      const esValorUtil = v => v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0';

      const OBJETIVOS = [
        ['textura',      /TEXTURA|TEXTTEXT/i],
        ['profundidad',  /PROF/i],
        ['drenaje',      /DREN/i],
        ['pendiente',    /PEND|SLOPE/i],
        ['erosion',      /EROS/i],
        ['pedregosidad', /PEDRE|PIEDR|PDG|ROCOS/i],
        ['ph',           /(^|_)PH($|_)|ACIDEZ/i],
        ['aptitud',      /APTITUD|APT/i]
      ];

      for (const [clave, rx] of OBJETIVOS) {
        // Campos candidatos: coinciden por nombre O por alias descriptivo
        const candidatos = fields.filter(fm => rx.test(fm.name) || rx.test(fm.alias || '')).map(fm => fm.name);
        // Recorre poligonos del predio del mas grande al mas chico y toma el primer valor real
        for (const { f } of intersecciones) {
          const dp = f.properties || {};
          const campo = candidatos.find(k => esValorUtil(dp[k])) ||
                        Object.keys(dp).find(k => rx.test(k) && esValorUtil(dp[k]));
          if (campo) { caracteristicas[clave] = decodificar(campo, dp[campo]); break; }
        }
      }

      if (!serie) {
        const rxS = /SERIE|ASOCIA/i;
        const candS = fields.filter(fm => rxS.test(fm.name) || rxS.test(fm.alias || '')).map(fm => fm.name);
        for (const { f } of intersecciones) {
          const dp = f.properties || {};
          const campo = candS.find(k => esValorUtil(dp[k])) || Object.keys(dp).find(k => rxS.test(k) && esValorUtil(dp[k]));
          if (campo) { serie = decodificar(campo, dp[campo]); break; }
        }
      }
    } catch (e) { debug.push({ paso:'caracteristicas-error', error: e.message }); }

    let respPlantaciones = null;
    let respFruticolaNota = '';
    let respCapaFrut = null;
    // 6c) SIT RURAL (visor.sitrural.cl/geoserver): capa "Suelos" de la comuna.
    // El GetCapabilities trae ~miles de capas organizadas por comuna (workspace tipo
    // "galvarino-sigcra"). El nombre tecnico es un codigo; la palabra "Suelos" va en
    // el <Title>. Se busca por titulo Y nombre, y la comuna por el prefijo/titulo.
    try {
      const SIT_WFS = 'https://visor.sitrural.cl/geoserver/ows';
      if (!cacheSitrural.capas) {
        const rc = await fetch(SIT_WFS + '?service=WFS&version=1.0.0&request=GetCapabilities');
        const xml = await rc.text();
        const capas = [];
        const rxFT = /<FeatureType[^>]*>([\s\S]*?)<\/FeatureType>/g;
        let mft;
        while ((mft = rxFT.exec(xml)) !== null) {
          const bloque = mft[1];
          const n = (bloque.match(/<Name>([^<]+)<\/Name>/) || [])[1] || '';
          const t = (bloque.match(/<Title>([^<]*)<\/Title>/) || [])[1] || '';
          if (n) capas.push({ n, t });
        }
        cacheSitrural.capas = capas;
        const soloSuelos = capas.filter(x => /suelo/i.test(x.t) || /suelo/i.test(x.n));
        debug.push({ paso:'sitrural-capas', status: rc.status, totalCapas: capas.length,
          capasSuelos: soloSuelos.length, ejemplos: soloSuelos.slice(0, 10).map(x => x.n + ' | ' + x.t) });
      }

      const objetivoCom = normU(comuna).replace(/\s+/g, '');
      // SIT Rural abrevia nombres de comuna ("Q.de Tilcoco", "Sn.Gregorio", "Pto.Natales"):
      // ademas del nombre completo, se calza por la palabra distintiva de la comuna.
      const GENERICAS = ['SAN','SANTA','SANTO','PUERTO','VILLA','ALTO','ALTA','BAJO','NUEVA','NUEVO','LA','EL','LOS','LAS','DE','DEL','RIO'];
      const palabraClave = (normU(comuna).split(' ').filter(w => w && !GENERICAS.includes(w))
        .sort((x, y) => y.length - x.length)[0]) || '';
      const esDeLaComuna = (x) => {
        const nn = normU(x.n).replace(/[\s_\-\.]/g, '');
        const tt = normU(x.t).replace(/[\s_\-\.]/g, '');
        if (nn.includes(objetivoCom) || tt.includes(objetivoCom)) return true;
        if (palabraClave.length >= 4 && (nn.includes(palabraClave) || tt.includes(palabraClave))) return true;
        return false;
      };
      const esSuelo = (x) => /suelo/i.test(x.t) || /suelo/i.test(x.n);
      // Prioridad: estudio agrologico ("Suelos <comuna>") > aptitud > cat. de uso/vegetacion
      const puntaje = (x) => {
        const t = normU(x.t);
        let p = 0;
        if (/^SUELOS?\b/.test(t)) p += 100;
        if (/AGROLOG|SERIE/.test(t)) p += 60;
        if (/APTITUD/.test(t)) p += 20;
        if (/USO|VEGET|CAT\.?/.test(t)) p -= 40;
        return p;
      };
      const candidatasSit = (cacheSitrural.capas || [])
        .filter(x => esSuelo(x) && esDeLaComuna(x))
        .sort((a, b) => puntaje(b) - puntaje(a));
      debug.push({ paso:'sitrural-candidatas', comuna: comuna,
        capas: candidatasSit.slice(0, 8).map(x => puntaje(x) + ' | ' + x.n + ' | ' + x.t) });

      const bbS = turf.bbox(predio);
      const centro = turf.centroid(predio).geometry.coordinates; // [lon, lat]
      let usadaSit = null, featsSit = null;

      const traerJson = async (url, etiqueta) => {
        try {
          const r = await fetch(url);
          const txt = await r.text();
          try {
            const j = JSON.parse(txt);
            debug.push({ paso:'sitrural-intento', intento: etiqueta, status: r.status, features: (j.features||[]).length });
            return j;
          } catch(e) {
            debug.push({ paso:'sitrural-intento', intento: etiqueta, status: r.status,
              respuesta: txt.substring(0, 400).replace(/\s+/g,' ') });
            return null;
          }
        } catch (e) {
          debug.push({ paso:'sitrural-intento', intento: etiqueta, error: e.message });
          return null;
        }
      };

      for (const cand of candidatasSit.slice(0, 2)) {
        // 1) Preguntar al servidor el nombre real del campo de geometria y los atributos
        let geomName = 'the_geom';
        try {
          const rd = await fetch(SIT_WFS + '?service=WFS&version=1.0.0&request=DescribeFeatureType&typeName=' + encodeURIComponent(cand.n));
          const xsd = await rd.text();
          const campos = [];
          const rxEl = /<xsd:element[^>]*name="([^"]+)"[^>]*type="([^"]+)"[^>]*>/g;
          let me;
          while ((me = rxEl.exec(xsd)) !== null) {
            campos.push(me[1] + ':' + me[2]);
            if (/gml:/.test(me[2]) && /Geometry|Point|Polygon|Line|Surface|Curve/i.test(me[2])) geomName = me[1];
          }
          debug.push({ paso:'sitrural-describe', capa: cand.t, geometria: geomName, atributos: campos.slice(0, 40) });
        } catch (e) { debug.push({ paso:'sitrural-describe', capa: cand.t, error: e.message }); }

        const base = SIT_WFS + '?service=WFS&request=GetFeature&typeName=' + encodeURIComponent(cand.n) +
          '&outputFormat=application/json&maxFeatures=300';

        // 2) Metodos de filtro espacial en cascada hasta que uno funcione
        const intentos = [
          ['1.0 BBOX+CRS',   base + '&version=1.0.0&srsName=EPSG:4326&CQL_FILTER=' +
            encodeURIComponent("BBOX(" + geomName + "," + bbS[0] + "," + bbS[1] + "," + bbS[2] + "," + bbS[3] + ",'EPSG:4326')")],
          ['1.0 BBOX ampliado', base + '&version=1.0.0&srsName=EPSG:4326&CQL_FILTER=' +
            encodeURIComponent("BBOX(" + geomName + "," + (bbS[0]-0.002) + "," + (bbS[1]-0.002) + "," + (bbS[2]+0.002) + "," + (bbS[3]+0.002) + ",'EPSG:4326')")],
          ['1.1 bbox lon-lat', base + '&version=1.1.0&srsName=EPSG:4326&bbox=' + [bbS[0], bbS[1], bbS[2], bbS[3], 'EPSG:4326'].join(',')],
          ['1.1 bbox lat-lon', base + '&version=1.1.0&srsName=EPSG:4326&bbox=' + [bbS[1], bbS[0], bbS[3], bbS[2], 'urn:x-ogc:def:crs:EPSG:4326'].join(',')]
        ];
        for (const [etiqueta, url] of intentos) {
          const j = await traerJson(url, cand.t + ' | ' + etiqueta);
          if (j && j.features && j.features.length) { usadaSit = cand; featsSit = j.features; break; }
        }
        if (featsSit) break;
      }

      if (featsSit) {
        debug.push({ paso:'sitrural-suelos', capa: usadaSit.t, features: featsSit.length,
          camposEjemplo: Object.keys(featsSit[0].properties || {}) });
        const interSit = [];
        for (const f of featsSit) {
          try {
            const inter = turf.intersect(turf.featureCollection([predio, f]));
            if (!inter) continue;
            const ha = turf.area(inter) / 10000;
            if (ha < 0.005) continue;
            interSit.push({ f, ha });
          } catch(e) {}
        }
        interSit.sort((a, b) => b.ha - a.ha);
        debug.push({ paso:'sitrural-interseccion', poligonos: interSit.length,
          propsDominante: interSit.length ? interSit[0].f.properties : null });

        if (interSit.length) {
          const util = v => v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0';
          // Cubre nombres descriptivos (pendiente) y nombres CIREN de shapefile (textpend1, textph2, textapag1...)
          const OBJ_SIT = [
            ['pendiente',    /PEND/i,                    null],
            ['profundidad',  /PROF/i,                    null],
            ['erosion',      /EROS/i,                    null],
            ['pedregosidad', /PEDR|PIEDR/i,              null],
            ['drenaje',      /DREN/i,                    null],
            ['textura',      /TEXTURA|TEXTTEXT|DESCTEXT/i, null],
            ['ph',           /(^|_)PH(_|\d|$)|TEXTPH/i,  null],
            ['aptitud',      /DESCAPAG|APTITUD|APT|APAG|AGRICOLA/i, /FRUT|APTF|DESRAPAG/i]
          ];
          // "Casi plana (1 a 3 %)": combina los campos dobles _1/_2 de SIT Rural
          // y convierte MAYUSCULAS SOSTENIDAS a formato de oracion
          const fmtVal = (v) => {
            v = String(v).trim();
            if (v.length > 2 && v === v.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(v)) {
              v = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
            }
            return v;
          };
          const tomar = (rx, evitar) => {
            const buscarEn = (permitirEvitado) => {
              for (const { f } of interSit) {
                const dp = f.properties || {};
                const claves = Object.keys(dp)
                  .filter(k => rx.test(k) && (permitirEvitado || !evitar || !evitar.test(k)) && util(dp[k]))
                  .sort();
                if (claves.length) {
                  const v1 = fmtVal(dp[claves[0]]);
                  const v2 = claves[1] && util(dp[claves[1]]) ? fmtVal(dp[claves[1]]) : '';
                  // No combinar cuando el primer valor ya es una oracion completa
                  if (v1.length > 60 || /\. /.test(v1)) return v1;
                  return (v2 && v2.toLowerCase() !== v1.toLowerCase()) ? (v1 + ' (' + v2 + ')') : v1;
                }
              }
              return '';
            };
            return buscarEn(false) || (evitar ? buscarEn(true) : '');
          };
          let algunaSit = false;
          for (const [clave, rx, evitar] of OBJ_SIT) {
            const v = tomar(rx, evitar);
            if (v) { caracteristicas[clave] = v; algunaSit = true; }
          }
          // Series de suelo del predio: puede haber varias (ej. "Perquenco, Metrenco 1, Metrenco 5").
          // Se recorren TODOS los poligonos que tocan el predio, se agrupan por serie+variacion
          // y se ordenan por superficie (la dominante primero).
          const rxSerie = /SERI/i; // cubre nombseri, serie, nom_serie, textserie
          const seriesHa = {};
          for (const { f, ha } of interSit) {
            const dp = f.properties || {};
            const kSerie = Object.keys(dp).filter(k => rxSerie.test(k) && !/SIMB/i.test(k) && util(dp[k])).sort()[0];
            if (!kSerie) continue;
            let nombre = fmtVal(dp[kSerie]);
            // Variacion de la serie (ej. simbolo "PQC-1" -> "Perquenco 1")
            const kVari = Object.keys(dp).filter(k => /VARI/i.test(k) && util(dp[k])).sort()[0];
            if (kVari) {
              const suf = String(dp[kVari]).trim().split('-')[1];
              if (suf) nombre += ' ' + suf;
            }
            seriesHa[nombre] = (seriesHa[nombre] || 0) + ha;
          }
          const listaSeries = Object.entries(seriesHa).sort((x, y) => y[1] - x[1]).map(e => e[0]);
          if (listaSeries.length) serie = listaSeries.join(', ');
          debug.push({ paso:'sitrural-series', series: Object.entries(seriesHa).map(e => e[0] + ' (' + (Math.round(e[1]*10)/10) + ' ha)') });
          if (algunaSit) debug.push({ paso:'sitrural-ok', caracteristicas, serie });
        }
      }

      // 6d) Catastro Fruticola CIREN (SIT Rural): cuarteles frutales dentro del predio
      try {
        const capaFrut = (cacheSitrural.capas || []).find(x => /FRUT/i.test(x.t) && esDeLaComuna(x));
        if (capaFrut) respCapaFrut = capaFrut.n;
        debug.push({ paso:'fruticola-capa', capa: capaFrut ? (capaFrut.n + ' | ' + capaFrut.t) : 'SIN CATASTRO FRUTICOLA PARA LA COMUNA' });
        if (capaFrut) {
          let geomF = 'thegeom';
          try {
            const rdf = await fetch(SIT_WFS + '?service=WFS&version=1.0.0&request=DescribeFeatureType&typeName=' + encodeURIComponent(capaFrut.n));
            const xsdf = await rdf.text();
            const rxElF = /<xsd:element[^>]*name="([^"]+)"[^>]*type="([^"]+)"[^>]*>/g;
            let mf;
            while ((mf = rxElF.exec(xsdf)) !== null) {
              if (/gml:/.test(mf[2]) && /Geometry|Point|Polygon|Line|Surface|Curve/i.test(mf[2])) geomF = mf[1];
            }
          } catch (e) {}
          const baseF = SIT_WFS + '?service=WFS&request=GetFeature&typeName=' + encodeURIComponent(capaFrut.n) +
            '&outputFormat=application/json&maxFeatures=500';
          const cqlF = "BBOX(" + geomF + "," + bbS[0] + "," + bbS[1] + "," + bbS[2] + "," + bbS[3] + ",'EPSG:4326')";
          const jf = await traerJson(baseF + '&version=1.0.0&srsName=EPSG:4326&CQL_FILTER=' + encodeURIComponent(cqlF), 'fruticola ' + capaFrut.t);
          if (jf && jf.features && jf.features.length) {
            debug.push({ paso:'fruticola-campos', campos: Object.keys(jf.features[0].properties || {}) });
            const utilF = v => v !== null && v !== undefined && String(v).trim() !== '';
            const buscarF = (dp, rx) => { const k = Object.keys(dp).filter(x => rx.test(x) && utilF(dp[x])).sort()[0]; return k ? String(dp[k]).trim() : ''; };
            const grupos = {};
            let nInter = 0, nCentro = 0, nFuera = 0, nError = 0;
            const haOficial = (f) => {
              const dp = f.properties || {};
              const k = Object.keys(dp).find(x => /SUP/i.test(x) && String(dp[x]).trim() !== '');
              return (k ? parseFloat(String(dp[k]).replace(',', '.')) : 0) || 0;
            };
            for (const f of jf.features) {
              let ha = 0;               // superficie del cuartel DENTRO del rol (recortada)
              let haCuartel = 0;        // superficie total del cuartel (para prorratear arboles)
              let dentro = false;
              let recortado = false;
              // Superficie total del cuartel (geometrica; sirve para el prorrateo de arboles)
              try { haCuartel = turf.area(f) / 10000; } catch (e) { haCuartel = 0; }
              // 1) Interseccion geometrica exacta: recorta el cuartel al poligono del rol.
              //    Esta es la superficie REAL de plantacion que pertenece a este predio.
              try {
                const inter = turf.intersect(turf.featureCollection([predio, f]));
                if (inter) {
                  ha = turf.area(inter) / 10000;
                  if (ha >= 0.005) { dentro = true; recortado = true; nInter++; }
                }
              } catch (e) {
                nError++;
                // Respaldo geometrico ante error de interseccion: buffer(0) repara la geometria
                try {
                  const f2 = turf.buffer(f, 0, { units: 'meters' });
                  const inter2 = turf.intersect(turf.featureCollection([predio, f2]));
                  if (inter2) {
                    ha = turf.area(inter2) / 10000;
                    if (ha >= 0.005) { dentro = true; recortado = true; nInter++; }
                  }
                } catch (e3) {}
              }
              // 2) Respaldo SOLO si no se pudo recortar geometricamente. En ese caso se
              //    acota la superficie a lo que fisicamente cabe en el rol para no inflar.
              if (!dentro) {
                try {
                  if (turf.booleanPointInPolygon(turf.centroid(f), predio)) {
                    const haC = haOficial(f) || haCuartel;
                    // Nunca atribuir al rol mas superficie que la del propio predio disponible
                    ha = Math.min(haC, superficieHa || haC);
                    dentro = true; nCentro++;
                  }
                } catch (e2) {}
              }
              if (!dentro) { nFuera++; continue; }
              const dp = f.properties || {};
              const especie = buscarF(dp, /ESPE/i);
              if (!especie) continue;
              const variedad = buscarF(dp, /VARI/i);
              const anio = buscarF(dp, /ANO|AGNO|PLANT/i).replace(/[^0-9]/g, '').substring(0, 4);
              const arbCuartel = parseFloat(buscarF(dp, /ARBO|N_?ARB/i)) || 0;
              // Arboles proporcionales a la fraccion del cuartel que cae dentro del rol
              const fraccion = (recortado && haCuartel > 0) ? Math.min(1, ha / haCuartel) : 1;
              const arboles = arbCuartel * fraccion;
              const clave = especie + '|' + variedad + '|' + anio;
              if (!grupos[clave]) grupos[clave] = { especie, variedad, anio, arboles: 0, has: 0 };
              grupos[clave].arboles += arboles;
              grupos[clave].has += ha;
            }
            const haTotalRolCrudo = Object.values(grupos).reduce((a, g) => a + g.has, 0);
            // ── Tope de seguridad final ──────────────────────────────────────────
            // Por diseño, lo plantado NUNCA puede superar la superficie del propio rol.
            // El recorte geometrico de arriba deberia garantizarlo, pero si CIREN entrega
            // cuarteles con geometria degenerada, o el poligono del rol tiene algun defecto,
            // esto evita -pase lo que pase- que la valorizacion reciba una cifra imposible:
            // se reescala TODO proporcionalmente para que la suma calce con el predio.
            let capoSeguridad = false;
            if (superficieHa > 0 && haTotalRolCrudo > superficieHa * 1.02) {
              const factor = superficieHa / haTotalRolCrudo;
              Object.values(grupos).forEach(g => { g.has *= factor; g.arboles *= factor; });
              capoSeguridad = true;
            }
            const haTotalRol = Object.values(grupos).reduce((a, g) => a + g.has, 0);
            debug.push({ paso:'fruticola-cruce', porInterseccion: nInter, porCentro: nCentro, fuera: nFuera, erroresGeometria: nError,
              haTotalAntesDelTope: Math.round(haTotalRolCrudo * 100) / 100,
              haRecortadaAlRol: Math.round(haTotalRol * 100) / 100, superficiePredioHa: Math.round(superficieHa * 100) / 100,
              topeDeSeguridadAplicado: capoSeguridad,
              nota: capoSeguridad
                ? ('ATENCION: la suma cruda de cuarteles (' + haTotalRolCrudo.toFixed(2) + ' ha) superaba el predio (' + superficieHa.toFixed(2) + ' ha); se reescalo proporcionalmente. Revisar en terreno.')
                : (nCentro > 0 ? ('ATENCION: ' + nCentro + ' cuartel(es) no se pudieron recortar geometricamente y se acotaron a la superficie del predio.') : 'Todas las plantaciones fueron recortadas al poligono del rol.') });
            const plantaciones = Object.values(grupos)
              .sort((x, y) => y.has - x.has)
              .map(p => ({ ...p, arboles: Math.round(p.arboles), has: Math.round(p.has * 100) / 100 }));
            if (plantaciones.length) {
              respPlantaciones = plantaciones;
              debug.push({ paso:'fruticola-ok', grupos: plantaciones.length, plantaciones });
            } else {
              // Buscar cuarteles COLINDANTES (a <250 m del predio): suelen ser de otro rol del mismo campo
              try {
                const zona = turf.buffer(predio, 0.25, { units: 'kilometers' });
                const cercanos = {};
                for (const f of jf.features) {
                  try {
                    if (!turf.booleanPointInPolygon(turf.centroid(f), zona)) continue;
                    const dp = f.properties || {};
                    const esp = buscarF(dp, /ESPE/i);
                    if (!esp) continue;
                    const k = (esp + ' ' + (buscarF(dp, /VARI/i) || '')).trim();
                    cercanos[k] = (cercanos[k] || 0) + (haOficial(f) || 0);
                  } catch (e2) {}
                }
                const lista = Object.entries(cercanos).map(e => e[0] + ' (' + (Math.round(e[1] * 10) / 10) + ' ha)');
                respFruticolaNota = lista.length
                  ? ('El rol no contiene cuarteles frutales, pero hay plantaciones COLINDANTES a menos de 250 m: ' + lista.join(', ') + '. Suelen pertenecer a otro rol del mismo campo: en el visor SIT Rural haz clic sobre el cuartel con la capa Propiedades activa para ver su rol y agregalo como Rol 2, o ingresalas manualmente.')
                  : 'La comuna tiene catastro fruticola CIREN, pero el predio no registra cuarteles frutales.';
              } catch (e) {
                respFruticolaNota = 'La comuna tiene catastro fruticola CIREN, pero el predio no registra cuarteles frutales.';
              }
              debug.push({ paso:'fruticola-ok', grupos: 0, nota: respFruticolaNota });
            }
          }
        }
      } catch (e) { debug.push({ paso:'fruticola-error', error: e.message }); }
    } catch (e) { debug.push({ paso:'sitrural-error', error: e.message }); }

    if (dominante) {
      camposDominante = dominante.properties || {};
      debug.push({ paso:'dominante', ha: Math.round(dominanteHa*100)/100, propiedades: camposDominante });
    }
    Object.keys(clases).forEach(k => clases[k] = Math.round(clases[k] * 100) / 100);

    // 7) Uso actual del suelo y vegetacion (catastro CONAF/IDE) - descubrimiento automatico del servicio
    const usos = {};
    try {
      if (cacheUso.svc === null) {
        const rroot = await fetch(CIREN_BASE + '?f=json');
        const jroot = await rroot.json();
        const cand = (jroot.services || []).find(s => /USO.*(SUELO|VEGETA)|VEGETACION|CATASTRO.*USO/i.test(s.name));
        cacheUso.svc = cand ? cand.name : 'no-disponible';
        debug.push({ paso:'descubrir-uso', servicios: (jroot.services||[]).map(s=>s.name), elegido: cacheUso.svc });
      }
      if (cacheUso.svc && cacheUso.svc !== 'no-disponible') {
        if (!cacheUso.capas) {
          const rc = await fetch(CIREN_BASE + '/' + cacheUso.svc + '/MapServer?f=json');
          const jc = await rc.json();
          cacheUso.capas = jc.layers || [];
        }
        let capaUso = cacheUso.capas.find(l => capa.kw.some(k => normU(l.name).includes(k))) || cacheUso.capas[0];
        if (capaUso) {
          const bb2 = turf.bbox(predio);
          const urlUso = CIREN_BASE + '/' + cacheUso.svc + '/MapServer/' + capaUso.id +
            '/query?geometry=' + bb2.join(',') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=geojson';
          const ru = await fetch(urlUso);
          const gu = await ru.json();
          debug.push({ paso:'uso-suelo', capa: capaUso.name, features: (gu.features||[]).length,
            campos: gu.features && gu.features[0] ? Object.keys(gu.features[0].properties||{}) : [] });
          if (gu.features && gu.features.length) {
            const p0 = gu.features[0].properties || {};
            const claveUso = Object.keys(p0).find(k => /USO(_ACTUAL|_TIERRA)?$|USO_SUELO|SUBUSO/i.test(k) && typeof p0[k] === 'string' && p0[k].trim()) ||
                             Object.keys(p0).find(k => typeof p0[k] === 'string' && p0[k].trim().length > 3 && !/comu|regi|prov|fuente|nom_|cod/i.test(k));
            debug.push({ paso:'campo-uso', claveUso });
            if (claveUso) {
              for (const f of gu.features) {
                try {
                  const inter = turf.intersect(turf.featureCollection([predio, f]));
                  if (!inter) continue;
                  const ha = turf.area(inter) / 10000;
                  if (ha < 0.01) continue;
                  const uso = String(f.properties[claveUso]).trim();
                  usos[uso] = Math.round(((usos[uso] || 0) + ha) * 100) / 100;
                } catch(e) {}
              }
            }
          }
        }
      }
    } catch(e) { debug.push({ paso:'uso-error', error: e.message }); }

    // Diagnostico claro cuando las clases vienen vacias
    let notaClases = '';
    if (!Object.keys(clases).length && gsu.features && gsu.features.length) {
      const muestra = gsu.features[0].properties || {};
      notaClases = 'ATENCION: encontre ' + gsu.features.length + ' poligonos de suelo pero no pude leer la clase. Propiedades de muestra: ' + JSON.stringify(muestra).substring(0, 400);
      debug.push({ paso:'muestra-suelo', propiedades: muestra });
    }

    const ordenRom = ['I','II','III','IV','V','VI','VII','VIII'];
    const capacidadUso = ordenRom.filter(r => clases[r] > 0).join('-');
    let predioGeo = null;
    try {
      const simple = turf.simplify(predio, { tolerance: 0.00008, highQuality: false });
      predioGeo = simple.geometry;
    } catch (e) { try { predioGeo = predio.geometry; } catch (e2) {} }
    res.json({ ok:true, superficieHa: superficieHa.toFixed(2), superficieSII: superficieSII, predioGeo, clases, serie, usos, plantaciones: respPlantaciones, fruticolaNota: respFruticolaNota, capaFruticola: respCapaFrut, caracteristicas, camposDominante, capacidadUso, notaClases, bbox: turf.bbox(predio), capaSueloId: capaSuelo ? capaSuelo.id : null, capaPredioId: capa.id, fuente:'CIREN - IDE Minagri (referencial)', debug });

  } catch (err) {
    console.error('Error /suelos-rol:', err);
    debug.push({ paso:'error-general', error: err.message });
    res.json({ ok:false, mensaje:'Error consultando CIREN: ' + err.message, debug });
  }
};
app.post('/suelos-rol', manejadorSuelos);
app.get('/suelos-rol', manejadorSuelos); // permite probar por link: /suelos-rol?rol=75-32&comuna=galvarino

// ──────── DIAGNOSTICO SIT RURAL v2 (abrir en el navegador: /diag-sitrural) ────────
// Lee el codigo de la pagina del visor SIT Rural y extrae las direcciones reales
// (API y geoservidor) que usa internamente, ademas de probar rutas candidatas.
app.get('/diag-sitrural', async (req, res) => {
  const salida = { version: 'v17' };
  const traer = async (url, comoTexto = true) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      const texto = comoTexto ? await r.text() : '';
      return { status: r.status, tipo: r.headers.get('content-type') || '', texto };
    } catch (e) { clearTimeout(t); return { error: e.message, texto: '' }; }
  };

  // 1) Pagina principal del visor
  const base = 'https://visor.sitrural.cl';
  const pag = await traer(base + '/mapa');
  salida.mapa = { status: pag.status, tipo: pag.tipo, largo: pag.texto.length };

  const urlsAbs = [...new Set((pag.texto.match(/https?:\/\/[^"'\s<>\\)]+/g) || []))].slice(0, 40);
  salida.urlsEnPagina = urlsAbs;

  const scripts = [...new Set((pag.texto.match(/src\s*=\s*["']([^"']+\.js[^"']*)["']/g) || [])
    .map(s => s.replace(/src\s*=\s*["']/, '').replace(/["']$/, '')))].slice(0, 6);
  salida.scripts = scripts;

  // 2) Leer los archivos JS del visor y extraer pistas
  salida.pistas = [];
  for (const s of scripts) {
    const urlS = s.startsWith('http') ? s : base + (s.startsWith('/') ? s : '/' + s);
    const js = await traer(urlS);
    if (js.error || !js.texto) { salida.pistas.push({ script: urlS, error: js.error || 'vacio' }); continue; }
    const urls = [...new Set((js.texto.match(/https?:\/\/[^"'\s\\)]+/g) || []))].slice(0, 30);
    const rutas = [...new Set((js.texto.match(/["'`]\/[a-zA-Z0-9_\-]{2,40}\/[a-zA-Z0-9_\-]{2,50}["'`]/g) || [])
      .map(x => x.slice(1, -1)))].slice(0, 60);
    const geo = [];
    const rxGeo = /geoserver|GetCapabilities|typeName|GetFeatureInfo|wms|wfs/gi;
    let m, cont = 0;
    while ((m = rxGeo.exec(js.texto)) !== null && cont < 12) {
      geo.push(js.texto.substring(Math.max(0, m.index - 60), m.index + 90).replace(/\s+/g, ' '));
      cont++;
      rxGeo.lastIndex = m.index + 200;
    }
    salida.pistas.push({ script: urlS, largo: js.texto.length, urls, rutasApi: rutas, contextoGeo: geo });
  }

  // 3) Rutas candidatas directas
  const candidatas = [
    base + '/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities',
    base + '/config/obtener_capas',
    base + '/config/obtener_arbol',
    base + '/capas/obtener_capas',
    base + '/buscador/buscar_capa?nombre=suelos'
  ];
  salida.candidatas = [];
  for (const url of candidatas) {
    const r = await traer(url);
    salida.candidatas.push({
      url, status: r.status, tipo: r.tipo, largo: r.texto.length,
      menciones: (r.texto.match(/[\w:]*[Ss]uelo[\w]*/g) || []).slice(0, 10),
      inicio: r.texto.substring(0, 250)
    });
  }
  res.json(salida);
});

app.post('/distancias', async (req, res) => {
  const { lat, lon, comuna } = req.body || {};
  if (!lat || !lon) return res.status(400).json({ ok:false, error:'Faltan coordenadas' });
  const debug = [];
  const la = parseFloat(String(lat).replace(',','.'));
  const lo = parseFloat(String(lon).replace(',','.'));
  const SCL = { lat: -33.4372, lon: -70.6506 }; // Plaza de Armas, Santiago

  const ruta = async (aLat, aLon, bLat, bLon, etiqueta) => {
    try {
      const u = 'https://router.project-osrm.org/route/v1/driving/' + aLon + ',' + aLat + ';' + bLon + ',' + bLat + '?overview=false';
      const r = await fetch(u, { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0' } });
      const j = await r.json();
      debug.push({ paso: etiqueta, status: r.status, code: j.code });
      if (j.routes && j.routes[0]) return { km: Math.round(j.routes[0].distance / 100) / 10, min: Math.round(j.routes[0].duration / 60) };
    } catch(e) { debug.push({ paso: etiqueta, error: e.message }); }
    // Respaldo: linea recta x 1.25 (factor vial tipico)
    const R = 6371, dLa = (bLat - aLat) * Math.PI/180, dLo = (bLon - aLon) * Math.PI/180;
    const h = Math.sin(dLa/2)**2 + Math.cos(aLat*Math.PI/180) * Math.cos(bLat*Math.PI/180) * Math.sin(dLo/2)**2;
    const recta = 2 * R * Math.asin(Math.sqrt(h));
    return { km: Math.round(recta * 1.25 * 10) / 10, min: null, estimado: true };
  };

  const santiago = await ruta(la, lo, SCL.lat, SCL.lon, 'ruta-santiago');

  // Centro comunal via Nominatim (geocodificador OpenStreetMap, gratis)
  let comunaDist = null, comunaNombre = null, accesoTxt = null;
  if (comuna) {
    try {
      const gu = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(comuna + ', Chile') + '&format=json&limit=1';
      const gr = await fetch(gu, { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0 (contacto@farmbrokers.cl)' } });
      const gj = await gr.json();
      debug.push({ paso: 'geocodificar-comuna', resultados: gj.length });
      if (gj[0]) {
        comunaNombre = comuna;
        comunaDist = await ruta(la, lo, parseFloat(gj[0].lat), parseFloat(gj[0].lon), 'ruta-comuna');
        // Acceso: nombres de las vias principales de la ruta centro comunal -> predio
        try {
          const us = 'https://router.project-osrm.org/route/v1/driving/' + gj[0].lon + ',' + gj[0].lat + ';' + lo + ',' + la + '?overview=false&steps=true';
          const rs = await fetch(us, { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0' } });
          const js = await rs.json();
          if (js.routes && js.routes[0] && js.routes[0].legs && js.routes[0].legs[0]) {
            const porVia = {};
            for (const st of (js.routes[0].legs[0].steps || [])) {
              const nom = (st.name || '').trim();
              if (!nom) continue;
              porVia[nom] = (porVia[nom] || 0) + (st.distance || 0);
            }
            const vias = Object.entries(porVia).sort((x, y) => y[1] - x[1]).slice(0, 3)
              .map(e => e[0] + ' (' + (Math.round(e[1] / 100) / 10) + ' km)');
            if (vias.length) {
              accesoTxt = 'Desde el centro de ' + comuna + ', el acceso se realiza principalmente por ' + vias.join(', luego ') + '.';
              debug.push({ paso: 'acceso-vias', vias });
            }
          }
        } catch (e) { debug.push({ paso: 'acceso-error', error: e.message }); }
      }
    } catch(e) { debug.push({ paso: 'geocodificar-error', error: e.message }); }
  }

  res.json({ ok:true, santiago, comuna: comunaDist, comunaNombre, acceso: accesoTxt, debug });
});

// ──────── DESLINDES REFERENCIALES: roles vecinos CIREN + vias OpenStreetMap ────────
app.post('/deslindes', async (req, res) => {
  const { bbox, capaPredioId, rol } = req.body || {};
  if (!bbox || !Array.isArray(bbox) || bbox.length !== 4 || capaPredioId === undefined) {
    return res.status(400).json({ ok:false, error:'Faltan bbox y capaPredioId (usa primero Suelos Auto)' });
  }
  const debug = [];
  const [minx, miny, maxx, maxy] = bbox.map(Number);
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const margen = 0.0012; // ~130 m fuera del borde
  const puntos = {
    norte:    { lon: cx, lat: maxy + margen },
    sur:      { lon: cx, lat: miny - margen },
    oriente:  { lon: maxx + margen, lat: cy },
    poniente: { lon: minx - margen, lat: cy }
  };
  const CIREN_Q = 'https://esri.ciren.cl/server/rest/services/IDEMINAGRI/PROPIEDADES_RURALES/MapServer/' + capaPredioId + '/query';
  const resultado = {};
  for (const [lado, p] of Object.entries(puntos)) {
    let texto = '';
    // 1) Rol vecino segun catastro CIREN
    try {
      const u = CIREN_Q + '?geometry=' + p.lon + ',' + p.lat + '&geometryType=esriGeometryPoint&inSR=4326' +
        '&spatialRel=esriSpatialRelIntersects&outFields=rol,desccomu&returnGeometry=false&f=json';
      const r = await fetch(u);
      const j = await r.json();
      const feat = j.features && j.features[0];
      if (feat && feat.attributes && feat.attributes.rol) {
        const rv = String(feat.attributes.rol);
        texto = (rol && rv === String(rol)) ? 'Con resto del mismo predio' : ('Con predio Rol ' + rv);
      }
      debug.push({ lado, paso:'rol-vecino', encontrado: feat ? (feat.attributes||{}).rol : null });
    } catch (e) { debug.push({ lado, paso:'rol-vecino-error', error: e.message }); }
    // 2) Via o hito geografico segun OpenStreetMap
    try {
      await sleep(1100); // limite de cortesia de Nominatim: 1 consulta/segundo
      const un = 'https://nominatim.openstreetmap.org/reverse?lat=' + p.lat + '&lon=' + p.lon + '&format=json&zoom=16&accept-language=es';
      const rn = await fetch(un, { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0 (contacto@farmbrokers.cl)' } });
      const jn = await rn.json();
      const via = jn.address && (jn.address.road || jn.address.river || jn.address.hamlet || jn.address.village);
      if (via) texto = texto ? (texto + ', ' + via + ' de por medio') : ('Con ' + via);
      debug.push({ lado, paso:'osm', via: via || null });
    } catch (e) { debug.push({ lado, paso:'osm-error', error: e.message }); }
    resultado[lado] = texto || 'Sin informacion referencial disponible';
  }
  res.json({ ok:true, ...resultado, nota:'Deslindes referenciales (catastro CIREN + OpenStreetMap). Validar con titulos de dominio.', debug });
});

// ──────── DERECHOS DE AGUA (DGA - Catastro Publico de Aguas) ────────
// La DGA publica un Excel por region con los derechos concedidos (actualizacion mensual).
// Se descarga una vez, se cachea en memoria y se cruza con el predio por coordenadas UTM.
const DGA_BASE = 'https://dga.mop.gob.cl/uploads/sites/13/2026/05/';
const DGA_REGIONES = {
  'ARICA Y PARINACOTA': 'Derechos_Concedidos_XV_Region.xls',
  'TARAPACA': 'Derechos_Concedidos_I_Region.xls',
  'ANTOFAGASTA': 'Derechos_Concedidos_II_Region.xls',
  'ATACAMA': 'Derechos_Concedidos_III_Region.xls',
  'COQUIMBO': 'Derechos_Concedidos_IV_Region.xls',
  'VALPARAISO': 'Derechos_Concedidos_V_Region.xls',
  'METROPOLITANA': 'Derechos_Concedidos_XIII_Region.xls',
  'OHIGGINS': 'Derechos_Concedidos_VI_Region.xls',
  'MAULE': 'Derechos_Concedidos_VII_Region.xls',
  'BIOBIO': 'Derechos_Concedidos_VIII_Region.xls',
  'NUBLE': 'Derechos_Concedidos_XVI_Region.xls',
  'ARAUCANIA': 'Derechos_Concedidos_IX_Region.xls',
  'LOS LAGOS': 'Derechos_Concedidos_X_Region.xls',
  'LOS RIOS': 'Derechos_Concedidos_XIV_Region.xls',
  'AYSEN': 'Derechos_Concedidos_XI_Region.xls',
  'MAGALLANES': 'Derechos_Concedidos_XII_Region.xls'
};
const cacheDGA = {}; // filas por region

const archivoRegion = (region) => {
  const r = normU(region);
  const k = Object.keys(DGA_REGIONES).find(x => r.includes(x) || x.includes(r));
  return k ? { clave: k, archivo: DGA_REGIONES[k] } : null;
};

const cargarDGA = async (region, debug, fresh) => {
  const info = archivoRegion(region);
  if (!info) return { error: 'Region no reconocida: ' + region };
  if (fresh) delete cacheDGA[info.clave];
  if (cacheDGA[info.clave]) { debug.push({ paso:'dga-cache', region: info.clave, filas: cacheDGA[info.clave].filas.length }); return { ...cacheDGA[info.clave], region: info.clave }; }
  try {
    const candidatosURL = [
      DGA_BASE + info.archivo,
      'https://dga.mop.gob.cl/DGADocumentos/' + info.archivo,
      'http://www.dga.cl/DGADocumentos/' + info.archivo,
      DGA_BASE + info.archivo.replace('.xls', '-1.xls'),
      'https://dga.mop.gob.cl/uploads/sites/13/2025/01/' + info.archivo.replace('.xls', '-1.xls')
    ];
    let buf = null, urlOk = null;
    for (const url of candidatosURL) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0' } });
        if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); urlOk = url; break; }
      } catch (e) {}
    }
    if (!buf) return { error: 'No se pudo descargar el Excel DGA desde ninguna de las rutas conocidas' };
    debug.push({ paso:'dga-url', url: urlOk });
    const wb = XLSX.read(buf, { type: 'buffer' });
    const hoja = wb.SheetNames[0];
    // Los Excel de la DGA traen filas de titulo antes de los encabezados:
    // se busca la fila que realmente contiene los nombres de las columnas.
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '', blankrows: false });
    const CLAVES = /COMUNA|CAUDAL|NOMBRE|SOLICITANTE|UTM|REGION|PROVINCIA|NATURALEZA|FUENTE|EJERCICIO|RESOLUCION/i;
    let idx = 0, mejor = -1;
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
      const puntos = (aoa[i] || []).filter(cell => CLAVES.test(String(cell))).length;
      if (puntos > mejor) { mejor = puntos; idx = i; }
    }
    const fila1 = aoa[idx] || [], fila2 = aoa[idx + 1] || [];
    // Encabezados en dos lineas (celdas combinadas): se unen ambas
    const dosLineas = (fila2.filter(x => String(x).trim()).length > fila1.length * 0.4) &&
                      (fila2.filter(x => CLAVES.test(String(x))).length > 0);
    const usados = {};
    const headers = fila1.map((h, j) => {
      let n = String(h || '').trim();
      if (dosLineas && String(fila2[j] || '').trim()) n = (n + ' ' + String(fila2[j]).trim()).trim();
      n = n || ('COL_' + j);
      // El Excel DGA repite nombres (ej. "Datum" para captacion y restitucion):
      // se renombra el duplicado para que no pise al primero
      if (usados[n]) { usados[n]++; n = n + '_' + usados[n]; } else { usados[n] = 1; }
      return n;
    });
    const inicio = idx + (dosLineas ? 2 : 1);
    const filas = aoa.slice(inicio)
      .filter(row => (row || []).some(x => String(x).trim()))
      .map(row => { const o = {}; headers.forEach((h, j) => { o[h] = row[j] !== undefined ? row[j] : ''; }); return o; });
    const paquete = { filas, headers, filaEncabezado: idx, dosLineas, muestraCruda: aoa.slice(0, Math.min(idx + 3, 8)) };
    cacheDGA[info.clave] = paquete;
    debug.push({ paso:'dga-descarga', region: info.clave, archivo: info.archivo, hoja, filaEncabezadoDetectada: idx, dosLineas, filas: filas.length });
    return { ...paquete, region: info.clave };
  } catch (e) { return { error: 'Error leyendo Excel DGA: ' + e.message }; }
};

// Diagnostico: muestra los nombres reales de columnas del Excel de la DGA
app.get('/diag-dga', async (req, res) => {
  const region = req.query.region || 'ohiggins';
  const debug = [];
  const { filas, error, headers, muestraCruda } = await cargarDGA(region, debug, req.query.fresh);
  if (error) return res.json({ ok:false, error, debug });
  res.json({
    ok: true, region, totalFilas: filas.length, encabezadosDetectados: headers, primerasFilasCrudas: muestraCruda,
    columnas: Object.keys(filas[0] || {}),
    ejemplo1: filas[0] || null,
    ejemplo2: filas[1] || null,
    debug
  });
});


// Busqueda de derechos: por comuna, por titular y por punto de captacion dentro del predio
const manejadorDerechos = async (req, res) => {
  const { region, comuna, titular, bbox } = Object.keys(req.body || {}).length ? req.body : (req.query || {});
  if (!region) return res.status(400).json({ ok:false, error:'Falta la region' });
  const debug = [];
  const { filas, error } = await cargarDGA(region, debug, (req.query||{}).fresh);
  if (error) return res.json({ ok:false, error, debug });
  if (!filas.length) return res.json({ ok:false, error:'El Excel de la DGA vino vacio', debug });

  const cols = Object.keys(filas[0]);
  const col = (rx) => cols.find(k => rx.test(normU(k)));
  const C = {
    comuna:   col(/COMUNA/),
    titular:  col(/NOMBRE.*SOLICITANTE|TITULAR|SOLICITANTE|PROPIETARIO|NOMBRE/),
    caudal:   col(/CAUDAL.*ANUAL.*PROMEDIO/) || col(/CAUDAL/),
    unidad:   col(/UNIDAD.*CAUDAL|UNIDAD/),
    tipoDer:  col(/TIPO.*DERECHO/),
    natur:    col(/NATURALEZA.*AGUA|NATURALEZA/),
    fuente:   col(/FUENTE|CAUCE/),
    ejercicio:col(/EJERCICIO/),
    utmNorte: col(/UTM.*NORTE.*CAPTACION/) || col(/UTM.*NORTE/) || col(/NORTE/),
    utmEste:  col(/UTM.*ESTE.*CAPTACION/) || col(/UTM.*ESTE/) || col(/ESTE/),
    huso:     col(/HUSO/) || col(/DATUM/),
    fecha:    col(/FECHA.*RESOL/) || col(/FECHA/),
    nroRes:   col(/N.*RESOL|RESOLUCION|CODIGO.*EXPEDIENTE/)
  };
  debug.push({ paso:'dga-columnas', version:'v40', detectadas: C, totalColumnas: cols.length, primeros10Encabezados: cols.slice(0, 10) });

  const objComuna = normU(comuna || '');
  const objTitular = normU(titular || '');
  let candidatas = filas;
  if (objComuna && C.comuna) candidatas = candidatas.filter(f => normU(f[C.comuna]).includes(objComuna));
  debug.push({ paso:'dga-filtro-comuna', comuna: objComuna, resultado: candidatas.length });

  const num = v => parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0;
  const mapear = (f, motivo) => {
    const g = (k) => (k && f[k] !== undefined && f[k] !== null) ? String(f[k]).replace(/\s+/g, ' ').trim() : '';
    const natur = g(C.natur), clas = g(C.clasFuente);
    return {
      titular: g(C.titular),
      tipo: [natur, clas].filter(Boolean).join(' - ') || g(C.tipoDer),
      naturaleza: natur,
      fuente: g(C.fuente),
      uso: g(C.uso),
      caudal: g(C.caudal),
      unidad: g(C.unidad),
      acciones: g(C.accCauce) || g(C.accFuente),
      ejercicio: g(C.ejercicio),
      profundidad: g(C.profundidad),
      resolucion: g(C.nroRes),
      fecha: g(C.fecha),
      cbr: g(C.cbr),
      fojas: g(C.fojas),
      nroCBR: g(C.nroCBR),
      anioCBR: g(C.anioCBR),
      comuna: g(C.comuna),
      motivo
    };
  };

  // Conversion UTM -> lat/lon respetando el Datum del registro.
  // Critico: un punto PSAD56 leido como WGS84 se desvia ~200 m y caeria fuera del predio.
  const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
  const defUTM = (huso, datumTxt) => {
    const d = normU(datumTxt || '');
    const base = '+proj=utm +zone=' + huso + ' +south +units=m +no_defs ';
    if (d.includes('PSAD')) return base + '+ellps=intl +towgs84=-302,272,-360,0,0,0,0';
    if (d.includes('SAD69') || d.includes('SAD 69')) return base + '+ellps=GRS67 +towgs84=-59,-11,-52,0,0,0,0';
    return base + '+datum=WGS84';
  };
  const encontrados = [];
  if (bbox) {
    const bb = (typeof bbox === 'string' ? JSON.parse(bbox) : bbox).map(Number);
    const zona = turf.buffer(turf.bboxPolygon(bb), 0.3, { units: 'kilometers' }); // margen 300 m
    let convertidos = 0, sinCoords = 0;
    const datums = {};
    for (const f of candidatas) {
      const N = C.utmNorte ? num(f[C.utmNorte]) : 0, E = C.utmEste ? num(f[C.utmEste]) : 0;
      if (!N || !E) { sinCoords++; continue; }
      const husoTxt = C.huso ? String(f[C.huso]) : '19';
      const huso = /18/.test(husoTxt) ? 18 : 19;
      const dTxt = C.datum ? String(f[C.datum]).trim() : '';
      datums[dTxt || '(vacio)'] = (datums[dTxt || '(vacio)'] || 0) + 1;
      let lat = null, lon = null;
      try { const p = proj4(defUTM(huso, dTxt), WGS84, [E, N]); lon = p[0]; lat = p[1]; convertidos++; } catch (e) { continue; }
      if (lat === null || !isFinite(lat) || !isFinite(lon)) continue;
      if (lat > 0 || lat < -60 || lon > -60 || lon < -80) continue; // coordenada fuera de Chile
      try {
        if (turf.booleanPointInPolygon(turf.point([lon, lat]), zona)) {
          encontrados.push({ ...mapear(f, 'Punto de captacion en el predio o a menos de 300 m'), lat: Math.round(lat*1e6)/1e6, lon: Math.round(lon*1e6)/1e6 });
        }
      } catch (e) {}
    }
    debug.push({ paso:'dga-por-coordenadas', convertidos, sinCoordenadas: sinCoords, datums, encontrados: encontrados.length });
  }
  // 2) Por titular
  if (objTitular && C.titular) {
    const porTit = candidatas.filter(f => normU(f[C.titular]).includes(objTitular))
      .filter(f => !encontrados.some(e => e.resolucion && e.resolucion === (C.nroRes ? String(f[C.nroRes]).trim() : '')))
      .slice(0, 40).map(f => mapear(f, 'Coincide con el titular'));
    encontrados.push(...porTit);
    debug.push({ paso:'dga-por-titular', titular: objTitular, encontrados: porTit.length });
  }

  res.json({
    ok: true,
    derechos: encontrados.slice(0, 60),
    totalComuna: candidatas.length,
    nota: 'Fuente: DGA - Catastro Publico de Aguas (actualizacion mensual). Los datos NO acreditan vigencia del dominio: validar con el Registro de Propiedad de Aguas del CBR.',
    debug
  });
};
app.post('/derechos-agua', manejadorDerechos);
app.get('/derechos-agua', manejadorDerechos); // prueba por link: /derechos-agua?region=ohiggins&comuna=quinta de tilcoco

// ──────── PROXY DE IMAGENES SIT RURAL (para dibujar la capa fruticola en el plano) ────────
app.get('/img-sitrural', async (req, res) => {
  try {
    const u = String(req.query.u || '');
    if (!u.startsWith('https://visor.sitrural.cl/geoserver/')) return res.status(400).send('URL no permitida');
    const r = await fetch(u, { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0' } });
    if (!r.ok) return res.status(502).send('Error del geoservidor');
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).send(e.message); }
});

// ──────── ESCASEZ HIDRICA: decretos vigentes segun pagina oficial DGA ────────
const cacheEscasez = { t: 0, decretos: null };
app.get('/escasez', async (req, res) => {
  const { comuna = '', provincia = '', region = '' } = req.query || {};
  try {
    if (!cacheEscasez.decretos || (Date.now() - cacheEscasez.t) > 12 * 3600 * 1000) {
      const r = await fetch('https://dga.mop.gob.cl/derechos-de-agua/proteccion-de-las-fuentes/decretos-de-escasez-2/', { headers: { 'User-Agent': 'FarmBrokersTasacion/1.0' } });
      const html = await r.text();
      const texto = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
      // Cada decreto es una oracion "Decreto MOP N°... caducidad DD-MM-AAAA"
      const trozos = texto.split(/(?=Decreto MOP)/g).filter(t => /caducidad/i.test(t)).map(t => t.substring(0, 400).trim());
      cacheEscasez.decretos = trozos; cacheEscasez.t = Date.now();
    }
    const hoy = new Date();
    const vigente = (t) => {
      const m = t.match(/caducidad\s+(\d{2})-(\d{2})-(\d{4})/i);
      if (!m) return false;
      return new Date(+m[3], +m[2] - 1, +m[1]) >= hoy;
    };
    const objetivos = [comuna, provincia, region].map(x => normU(x)).filter(x => x.length > 3);
    const coincidencias = cacheEscasez.decretos.filter(t => {
      if (!vigente(t)) return false;
      const tn = normU(t);
      return objetivos.some(o => tn.includes(o));
    });
    res.json({ ok: true, enEscasez: coincidencias.length > 0, decretos: coincidencias.slice(0, 3),
      totalVigentesPais: cacheEscasez.decretos.filter(vigente).length,
      nota: 'Fuente: DGA (pagina oficial de decretos de escasez). Verificacion referencial por nombre de comuna/provincia/region.' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Servidor Farm Brokers corriendo en puerto ${PORT}`);
});
