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
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API v16', simpleapi: !!SIMPLEAPI_KEY });
});

// ─────────────────────────── GENERAR INFORME (IA) ───────────────────────────
app.post('/generar-informe', async (req, res) => {
  try {
    const datos = req.body;
    if (!datos.predioNombre) return res.status(400).json({ error: 'Falta el nombre del predio' });

    const instruccion = `Eres tasador agricola experto de Farm Brokers Chile. Con los datos del predio a continuacion, redacta textos profesionales en espanol para un Informe de Tasacion.

DATOS DEL PREDIO:
PREDIO: ${datos.predioNombre}
ROLES SII: ${(datos.roles || []).map(r => r.rol).join(', ')}
COMUNA: ${datos.roles?.[0]?.comuna || ''} | PROVINCIA: ${datos.provincia} | REGION: ${datos.region}
LOCALIDAD: ${datos.localidad}
PROPIETARIO: ${(datos.roles || []).map(r => r.datos?.propietario).filter(Boolean).join(', ')}
AVALUO TOTAL: $${datos.avaluoTotal || 0} | UF BASE: ${datos.ufBase}
SUPERFICIES: Titulos ${datos.superfTitulos} ha, SII ${datos.superfSIITotal} ha, Google Earth ${datos.superfGoogleEarth} ha
SUELOS: ${datos.suelosDetalle || ("Clase I " + datos.c1 + " ha, II " + datos.c2 + " ha, III " + datos.c3 + " ha, IV " + datos.c4 + " ha")}
SERIE: ${datos.seriesSuelo} | PENDIENTE: ${datos.pendiente} | DRENAJE: ${datos.drenaje}
AGUA: ${datos.cn1} (${datos.ca1} acciones, ${datos.cq1} l/s) | ${datos.cn2 || ''} (${datos.ca2 || ''} acciones)
PLANTACIONES: ${datos.plantacionDesc} (${datos.plantacionHas} ha)
CONSTRUCCIONES: ${datos.construcciones}
COORDENADAS: ${datos.coordLat} S, ${datos.coordLon} O | DISTANCIA SANTIAGO: ${datos.distSantiago} km
ACCESO: ${datos.acceso}

Responde UNICAMENTE con un objeto JSON valido (sin markdown, sin bloques de codigo, sin texto antes ni despues), con exactamente estos 8 campos de texto:
- resumen: 2-3 oraciones breves describiendo el predio, ubicacion y uso actual
- ubicacion: 1-2 oraciones con coordenadas, distancia a Santiago y acceso
- titulos: 1 parrafo breve sobre inscripcion y deslindes
- suelos: 1 parrafo breve sobre clasificacion de suelos segun SII
- ciren: 1 parrafo breve con caracteristicas de la serie de suelo
- clima: 1 parrafo sobre clima mediterraneo semiarido de la zona
- hidrico: 1 parrafo breve sobre derechos de aprovechamiento de aguas
- conclusiones: 2 parrafos breves de conclusiones profesionales de tasacion

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

app.post('/buscar-rol', async (req, res) => {
  const { rol, comuna } = req.body || {};
  if (!rol || !comuna) return res.status(400).json({ ok: false, error: 'Faltan rol y comuna' });
  if (!SIMPLEAPI_KEY) return res.json({ ok: false, error: 'Falta configurar SIMPLEAPI_KEY en Railway (Variables)' });

  const debug = [];
  const headers = { 'Authorization': SIMPLEAPI_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const rolLimpio = String(rol).trim();
  const comunaLimpia = String(comuna).trim();

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
  for (let intento = 1; intento <= 3 && !resultado; intento++) {
    const r = await intentar(URL, { method: 'POST', headers, body: bodyDirecto }, debug, 'POST directo (intento ' + intento + ')');
    if (r && r.__status === 200) { resultado = r; break; }
    if (r && Array.isArray(r.data) && r.data.some(x => x.Comuna || x.comuna)) {
      listaComunas = r.data; cacheComunas.lista = listaComunas;
      break; // nos devolvio alternativas de comuna: pasamos a resolverla
    }
    if (esErrorComunas(r)) { await sleep(4000); continue; } // transitorio: esperar y reintentar
    if (r && r.__status === 401) {
      return res.json({ ok: false, mensaje: 'SimpleAPI rechazo la API key (401). Revisa SIMPLEAPI_KEY en Railway.', debug });
    }
    break; // otro tipo de error: no insistir por la misma via
  }

  // ── Paso 2 (plan B): pedir el catalogo de comunas a su endpoint dedicado ──
  if (!resultado && !listaComunas) {
    const rutasComunas = [
      { url: BASE + '/comunas', opts: { method: 'GET', headers }, label: 'GET comunas' },
      { url: BASE + '/comunas', opts: { method: 'POST', headers, body: JSON.stringify({}) }, label: 'POST comunas' }
    ];
    for (const rc of rutasComunas) {
      await sleep(2000);
      const r = await intentar(rc.url, rc.opts, debug, rc.label);
      const arr = r && (Array.isArray(r) ? r : (Array.isArray(r.data) ? r.data : null));
      if (arr && arr.length && arr.some(x => x.Comuna || x.comuna || x.Nombre || x.nombre)) {
        listaComunas = arr; cacheComunas.lista = arr;
        break;
      }
    }
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

  res.json({ ok: true, datos: datosMap, raw: cand, debug });
});


// ──────── SUELOS AUTOMATICOS: CIREN Propiedades Rurales + Estudio Agrologico ────────
const turf = require('@turf/turf');

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

const normU = s => (s||'').toString().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

function claseDesdeTexto(v){
  const t = normU(v).trim();
  const m = t.match(/^(VIII|VII|VI|V|IV|III|II|I)/);
  if (m) return m[1];
  const n = t.match(/^([1-8])/);
  if (n) return ['I','II','III','IV','V','VI','VII','VIII'][parseInt(n[1])-1];
  return null;
}

app.post('/suelos-rol', async (req, res) => {
  const { rol, comuna, region } = req.body || {};
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
      if (gj2.features && gj2.features.length) gj.features = gj2.features;
      else return res.json({ ok:false, mensaje:'CIREN no tiene el rol ' + rolLimpio + ' en su capa de la region (cobertura ' + JSON.stringify(capa.kw[0]) + '). Ingresa los suelos manualmente.', debug });
    }

    const predio = gj.features[0];
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

    // 6c) SIT RURAL (visor.sitrural.cl): capa "Recursos Naturales > Suelos" de la comuna.
    // Trae las descripciones oficiales en texto (Serie, Pendiente, Profundidad, Erosion,
    // Pedregosidad, Drenaje, Textura, pH, Aptitud). Si existe, tiene prioridad.
    try {
      const SIT_WFS = 'https://visor.sitrural.cl/geoserver/ows';
      if (!cacheSitrural.capas) {
        const rc = await fetch(SIT_WFS + '?service=WFS&version=1.0.0&request=GetCapabilities');
        const xml = await rc.text();
        const nombres = [];
        const rxName = /<Name>([^<]+)<\/Name>/g;
        let mm;
        while ((mm = rxName.exec(xml)) !== null) {
          if (/suelo/i.test(mm[1])) nombres.push(mm[1]);
        }
        cacheSitrural.capas = nombres;
        debug.push({ paso:'sitrural-capas', status: rc.status, capasSuelos: nombres.slice(0, 30) });
      }
      const objetivoCom = normU(comuna).replace(/\s+/g, '_');
      const objetivoCom2 = normU(comuna).replace(/\s+/g, '');
      const capaSit = (cacheSitrural.capas || []).find(n => {
        const nn = normU(n).replace(/\s+/g, '_');
        return nn.includes(objetivoCom) || nn.replace(/_/g, '').includes(objetivoCom2);
      });
      debug.push({ paso:'sitrural-capa-comuna', comuna: comuna, capa: capaSit || 'NO ENCONTRADA' });

      if (capaSit) {
        const bbS = turf.bbox(predio);
        const urlSit = SIT_WFS + '?service=WFS&version=1.0.0&request=GetFeature&typeName=' +
          encodeURIComponent(capaSit) + '&outputFormat=application/json&srsName=EPSG:4326' +
          '&bbox=' + bbS.join(',') + '&maxFeatures=300';
        const rs2 = await fetch(urlSit);
        const gj2 = await rs2.json();
        debug.push({ paso:'sitrural-suelos', status: rs2.status, features: (gj2.features||[]).length,
          camposEjemplo: gj2.features && gj2.features[0] ? Object.keys(gj2.features[0].properties||{}) : [] });

        if (gj2.features && gj2.features.length) {
          // Interseccion con el predio y orden por superficie
          const interSit = [];
          for (const f of gj2.features) {
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
            // Excluye campos que empiezan con "text" pero son otra cosa (textcaus = capacidad de uso, etc.)
            const OBJ_SIT = [
              ['pendiente',    /PEND/i,               null],
              ['profundidad',  /PROF/i,               null],
              ['erosion',      /EROS/i,               null],
              ['pedregosidad', /PEDR|PIEDR/i,         null],
              ['drenaje',      /DREN/i,               null],
              ['textura',      /TEXTURA|TEXTTEXT/i,   null],
              ['ph',           /(^|_)PH(_|\d|$)/i,    null],
              ['aptitud',      /APT/i,                /FRUT/i]  // prefiere aptitud agricola sobre frutal
            ];
            const tomar = (rx, evitar) => {
              for (const { f } of interSit) {
                const dp = f.properties || {};
                const claves = Object.keys(dp)
                  .filter(k => rx.test(k) && (!evitar || !evitar.test(k)) && util(dp[k]))
                  .sort();
                if (claves.length) return String(dp[claves[0]]).trim();
              }
              // segunda pasada permitiendo el campo evitado (ej. solo hay aptitud frutal)
              if (evitar) {
                for (const { f } of interSit) {
                  const dp = f.properties || {};
                  const claves = Object.keys(dp).filter(k => rx.test(k) && util(dp[k])).sort();
                  if (claves.length) return String(dp[claves[0]]).trim();
                }
              }
              return '';
            };
            let algunaSit = false;
            for (const [clave, rx, evitar] of OBJ_SIT) {
              const v = tomar(rx, evitar);
              if (v) { caracteristicas[clave] = v; algunaSit = true; }
            }
            const vSerie = tomar(/^SERIE|_SERIE|NOM.?SERIE/i, /SIMB/i);
            if (vSerie) { serie = vSerie; algunaSit = true; }
            if (algunaSit) debug.push({ paso:'sitrural-ok', caracteristicas, serie });
          }
        }
      }
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
    res.json({ ok:true, superficieHa: superficieHa.toFixed(2), clases, serie, usos, caracteristicas, camposDominante, capacidadUso, notaClases, bbox: turf.bbox(predio), capaSueloId: capaSuelo ? capaSuelo.id : null, capaPredioId: capa.id, fuente:'CIREN - IDE Minagri (referencial)', debug });

  } catch (err) {
    console.error('Error /suelos-rol:', err);
    debug.push({ paso:'error-general', error: err.message });
    res.json({ ok:false, mensaje:'Error consultando CIREN: ' + err.message, debug });
  }
});

// ──────── DIAGNOSTICO SIT RURAL (abrir en el navegador: /diag-sitrural) ────────
app.get('/diag-sitrural', async (req, res) => {
  const candidatas = [
    'https://visor.sitrural.cl/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities',
    'https://visor.sitrural.cl/geoserver/wms?service=WMS&request=GetCapabilities',
    'https://visor.sitrural.cl/geoserver/web/',
    'https://geoserver.sitrural.cl/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities',
    'https://idesitrural.ciren.cl/geoserver/ows?service=WFS&version=1.0.0&request=GetCapabilities',
    'https://visor.sitrural.cl/config/obtener_capas',
    'https://visor.sitrural.cl/capas/obtener_capas',
    'https://visor.sitrural.cl/capa/obtener_capas',
    'https://visor.sitrural.cl/mapa/obtener_capas',
    'https://visor.sitrural.cl/config/obtener_configuracion'
  ];
  const resultados = [];
  for (const url of candidatas) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': '*/*' } });
      clearTimeout(t);
      const texto = await r.text();
      resultados.push({
        url,
        status: r.status,
        tipo: r.headers.get('content-type') || '',
        largo: texto.length,
        capasSuelos: (texto.match(/[\w:]*[Ss]uelo[\w]*/g) || []).slice(0, 15),
        inicio: texto.substring(0, 300)
      });
    } catch (e) {
      resultados.push({ url, error: e.message });
    }
  }
  res.json({ version: 'v16', resultados });
});

app.listen(PORT, () => {
  console.log(`Servidor Farm Brokers corriendo en puerto ${PORT}`);
}); 
