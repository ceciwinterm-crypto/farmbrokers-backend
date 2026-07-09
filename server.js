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
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API v11', simpleapi: !!SIMPLEAPI_KEY });
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

  // Rutas candidatas (SimpleAPI Mapas). Si SIMPLEAPI_URL esta definida, se usa solo esa.
  const URL = SIMPLEAPI_URL || 'https://servicios.simpleapi.cl/api/mapas/buscar/rol';

  // El rol suele venir como "manzana-predio". Preparamos variantes de body.
  const partes = rolLimpio.split('-').map(s => s.trim());
  const manzana = partes[0] || '';
  const predio = partes[1] || '';

  const norm = s => (s||'').toString().trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

  let resultado = null;
  let listaComunas = cacheComunas.lista;
  let comunaId = null;

  // Paso 1: si no tenemos la lista de comunas en cache, hacemos una consulta inicial.
  // Si la comuna en texto funcionara directo (200), usamos ese resultado.
  if (!listaComunas) {
    const primer = await intentar(URL, { method: 'POST', headers, body: JSON.stringify({ comuna: comunaLimpia, manzana, predio }) }, debug, 'POST inicial');
    if (primer && primer.__status === 200) resultado = primer;
    if (primer && Array.isArray(primer.data) && primer.data.some(x => x.Comuna || x.comuna)) {
      listaComunas = primer.data;
      cacheComunas.lista = listaComunas;
    }
    await sleep(1300);
  }

  // Paso 2: resolver la comuna por nombre (nos quedamos con el nombre EXACTO de su lista y su Id)
  let comunaNombre = null;
  if (!resultado && Array.isArray(listaComunas)) {
    const objetivo = norm(comunaLimpia);
    const found = listaComunas.find(x => norm(x.Comuna || x.comuna) === objetivo);
    if (found) {
      comunaId = found.Id || found.id || found.ID;
      comunaNombre = found.Comuna || found.comuna;
    }
    debug.push({ label: 'comuna-resuelta', comunaId: comunaId || 'NO ENCONTRADA', comunaNombre: comunaNombre || '-', buscado: objetivo, totalComunas: listaComunas.length });
  }

  // Paso 3: buscar el rol usando el nombre exacto (y el Id como respaldo)
  if (!resultado && (comunaNombre || comunaId)) {
    const bodies = [];
    if (comunaNombre) bodies.push({ comuna: comunaNombre, manzana, predio });
    if (comunaNombre) bodies.push({ comuna: comunaNombre, manzana: Number(manzana) || manzana, predio: Number(predio) || predio });
    if (comunaId) bodies.push({ comuna: comunaId, manzana, predio });
    for (const b of bodies) {
      const r = await intentar(URL, { method: 'POST', headers, body: JSON.stringify(b) }, debug, 'POST ' + JSON.stringify(b));
      if (r && r.__status === 200) { resultado = r; break; }
      await sleep(1300);
    }
  }

  if (!resultado) {
    return res.json({ ok: false, mensaje: 'Ninguna ruta respondio con datos. Revisa el detalle.', debug });
  }

  // Mapeo flexible de campos (el formato exacto de SimpleAPI puede variar)
  const cand = (resultado && (resultado.Datos || resultado.datos)) || (Array.isArray(resultado) ? resultado[0] : (resultado.data || resultado.predio || resultado.resultado || resultado));
  const g = (o, ...keys) => { for (const k of keys) { if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; } return ''; };

  // Nombres reales confirmados de SimpleAPI Mapas: Datos.ValorTotal, PosicionX (latitud), PosicionY (longitud)
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

    // 6) Interseccion y hectareas por clase
    const clases = {};
    let serie = '';
    for (const f of gsu.features) {
      try {
        const inter = turf.intersect(turf.featureCollection([predio, f]));
        if (!inter) continue;
        const ha = turf.area(inter) / 10000;
        if (ha < 0.005) continue;
        const clase = claveClase ? claseDesdeTexto(f.properties[claveClase]) : null;
        if (clase) clases[clase] = (clases[clase] || 0) + ha;
        if (!serie && claveSerie && f.properties[claveSerie]) serie = String(f.properties[claveSerie]);
      } catch(e) { debug.push({ paso:'interseccion-error', error: e.message }); }
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

    res.json({ ok:true, superficieHa: superficieHa.toFixed(2), clases, serie, usos, notaClases, bbox: turf.bbox(predio), capaSueloId: capaSuelo ? capaSuelo.id : null, capaPredioId: capa.id, fuente:'CIREN - IDE Minagri (referencial)', debug });

  } catch (err) {
    console.error('Error /suelos-rol:', err);
    debug.push({ paso:'error-general', error: err.message });
    res.json({ ok:false, mensaje:'Error consultando CIREN: ' + err.message, debug });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Farm Brokers corriendo en puerto ${PORT}`);
});
