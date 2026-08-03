// ============================================================
// SERVER.JS - PARTE 1 (copia esto primero)
// ============================================================

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SIMPLEAPI_KEY = process.env.SIMPLEAPI_KEY;
const SIMPLEAPI_URL = process.env.SIMPLEAPI_URL;
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) console.error('ERROR: Falta ANTHROPIC_API_KEY');
if (!SIMPLEAPI_KEY) console.warn('AVISO: Falta SIMPLEAPI_KEY');

// ── Funciones auxiliares ──
function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function extraerJSON(texto) {
  const limpio = String(texto || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const inicio = limpio.indexOf('{');
  if (inicio === -1) return null;
  let profundidad = 0, dentroString = false, escapando = false;
  for (let i = inicio; i < limpio.length; i++) {
    const ch = limpio[i];
    if (escapando) { escapando = false; continue; }
    if (ch === '\\') { escapando = true; continue; }
    if (ch === '"') { dentroString = !dentroString; continue; }
    if (dentroString) continue;
    if (ch === '{') profundidad++;
    else if (ch === '}') {
      profundidad--;
      if (profundidad === 0) {
        const candidato = limpio.substring(inicio, i + 1);
        try { return JSON.parse(candidato); } catch (e) { return null; }
      }
    }
  }
  return null;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API', simpleapi: !!SIMPLEAPI_KEY });
});

// ════════════════════════════════════════════════════════════
// 1. GENERAR INFORME (IA)
// ════════════════════════════════════════════════════════════
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
CLASIFICACION SII (fiscal, base del avaluo — puede diferir de la agrologica): ${datos.clasesSIITxt || "sin desglose fiscal disponible"}
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
- suelos: 1 parrafo breve sobre clasificacion de suelos. Si existen la clasificacion agrologica (CIREN/SIT Rural) y la CLASIFICACION SII fiscal y difieren, menciona AMBAS con sus cifras y aclara que la fiscal es la registrada por el SII para el avaluo y la agrologica la del estudio de suelos; nunca las mezcles como si fueran una sola
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

// ════════════════════════════════════════════════════════════
// 2. BUSCAR PROPIETARIO POR ROL
// ════════════════════════════════════════════════════════════
app.post('/buscar-propietario', async (req, res) => {
  try {
    const { rol, comuna, region } = req.body || {};
    if (!rol || !comuna) return res.status(400).json({ ok: false, mensaje: 'Falta rol o comuna.' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, mensaje: 'Falta ANTHROPIC_API_KEY en el servidor.' });

    const prompt = `Necesito identificar al propietario de un predio agrícola en Chile a partir de documentos PUBLICOS OFICIALES, y si es una EMPRESA, tambien su RUT.

Rol de avalúo: ${rol}
Comuna: ${comuna}
Región: ${region || '(no especificada)'}

PASO 1 — Propietario:
Busca el documento oficial "Rol de Avalúos y Contribuciones Bienes Raíces Agrícolas" (o "Rol de Avalúo") que la Municipalidad de ${comuna}, o en su defecto el SII, publica en su sitio web (normalmente un PDF). Ese documento lista, por cada rol, el nombre del propietario y el nombre o dirección del predio.

Encuentra dentro de ese documento la línea EXACTA correspondiente al rol ${rol}. Debes encontrar el numero de rol EXACTO, no uno parecido.

Reglas estrictas para el Paso 1:
- Solo usa fuentes gubernamentales o municipales oficiales (municipalidad.cl, sii.cl) para el propietario y nombre del predio.
- Extrae el nombre del propietario y el nombre del predio TAL COMO aparecen en el documento, sin corregir ni completar nada.
- Si NO encuentras el documento, o no encuentras la linea exacta de ese rol, responde que no se encontro. Nunca inventes ni "completes" un nombre parecido.

PASO 2 — RUT (SOLO si el propietario encontrado en el Paso 1 es una EMPRESA):
IMPORTANTE: los documentos municipales suelen truncar el nombre del propietario a ~25 caracteres. Un nombre que empieza con "AGRICOLA" casi siempre es una empresa aunque el sufijo "Limitada"/"SpA" haya quedado cortado por el ancho de columna del PDF — trátalo como empresa igual, e intenta encontrar su razón social COMPLETA (con el sufijo legal) en el directorio de empresas antes de buscar el RUT.

Si el nombre del propietario corresponde claramente a una empresa (empieza con "Agricola", o contiene "Limitada", "Ltda", "S.A.", "SpA", "Sociedad", "EIRL", "Comercial", "Inmobiliaria", "Inversiones", etc.), busca su RUT en directorios chilenos de empresas que agreguen datos oficiales (por ejemplo portalchile.org, u otros que citen como fuente al SII/INAPI/Mercado Publico/CMF).

Reglas estrictas para el Paso 2:
- Solo entrega el RUT si encuentras una coincidencia EXACTA e INEQUIVOCA de la razón social completa (no una empresa con nombre parecido).
- Si existen varias empresas con nombres similares, o no hay coincidencia exacta y clara, deja el RUT vacío y explica la ambiguedad en notaIncertidumbre.
- Si el propietario es una PERSONA NATURAL (nombre de persona, no una razón social de empresa), NO busques su RUT bajo ninguna circunstancia: por privacidad, ese dato SIEMPRE debe completarlo el tasador manualmente. Deja rut vacio en ese caso.
- Nunca calcules ni inventes un RUT ni su dígito verificador: solo repórtalo si lo viste literalmente en una fuente real.

Responde EXCLUSIVAMENTE con un JSON (sin texto antes ni despues, sin \`\`\`), con esta forma exacta:
{"encontrado":true|false,"propietario":"...","nombrePredio":"...","fuenteUrl":"...","fuenteNombre":"...","fechaDocumento":"...","esEmpresa":true|false,"rut":"...","rutFuenteUrl":"...","rutFuenteNombre":"...","notaIncertidumbre":"..."}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error (buscar-propietario):', response.status, errText);
      return res.status(502).json({ ok: false, mensaje: 'Error de la API de Claude al buscar.', detail: errText.substring(0, 500) });
    }

    const data = await response.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
    const fuentesConsultadas = (data.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (Array.isArray(b.content) ? b.content : []))
      .map(r => r && r.url).filter(Boolean);

    const resultado = extraerJSON(texto);
    if (!resultado) {
      return res.json({ ok: false, mensaje: 'La busqueda no devolvio una respuesta interpretable (o se corto por longitud). Verifica manualmente.', fuentesConsultadas });
    }

    if (!resultado.encontrado) {
      return res.json({ ok: true, encontrado: false,
        mensaje: 'No se encontro un documento oficial con el rol exacto ' + rol + ' en ' + comuna + '. Completa el propietario manualmente.',
        fuentesConsultadas });
    }

    const propietarioTxt = String(resultado.propietario || '');
    const pareceEmpresa = /\bLIMITADA\b|\bLTDA\b|\bS\.?A\.?\b|\bSPA\b|\bSOCIEDAD\b|\bEIRL\b|\bCOMERCIAL\b|^AGRICOLA\b|\bINMOBILIARIA\b|\bINVERSIONES\b|\bFORESTAL\b|\bFRUTICOLA\b|\bCONSTRUCTORA\b|\bTRANSPORTES\b/i.test(propietarioTxt);
    const rutSeguro = pareceEmpresa ? String(resultado.rut || '').trim() : '';
    const rutDescartadoPorPersona = !pareceEmpresa && String(resultado.rut || '').trim() !== '';

    return res.json({
      ok: true, encontrado: true,
      propietario: propietarioTxt.trim(),
      nombrePredio: String(resultado.nombrePredio || '').trim(),
      fuenteUrl: String(resultado.fuenteUrl || '').trim(),
      fuenteNombre: String(resultado.fuenteNombre || '').trim(),
      fechaDocumento: String(resultado.fechaDocumento || '').trim(),
      rut: rutSeguro,
      rutFuenteUrl: rutSeguro ? String(resultado.rutFuenteUrl || '').trim() : '',
      rutFuenteNombre: rutSeguro ? String(resultado.rutFuenteNombre || '').trim() : '',
      notaIncertidumbre: String(resultado.notaIncertidumbre || '').trim() + (rutDescartadoPorPersona ? ' (Se descartó un RUT devuelto por la búsqueda porque el propietario parece persona natural: ese dato queda siempre manual.)' : ''),
      fuentesConsultadas
    });
  } catch (err) {
    console.error('Error en /buscar-propietario:', err);
    res.status(500).json({ ok: false, mensaje: 'Error del servidor: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
// 3. BUSCAR ROL VIA SIMPLEAPI
// ════════════════════════════════════════════════════════════
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

const cacheComunas = { lista: null };
const cacheBusquedas = {};

app.post('/buscar-rol', async (req, res) => {
  const { rol, comuna } = req.body || {};
  if (!rol || !comuna) return res.status(400).json({ ok: false, error: 'Faltan rol y comuna' });
  if (!SIMPLEAPI_KEY) return res.json({ ok: false, error: 'Falta configurar SIMPLEAPI_KEY en Railway (Variables)' });

  const debug = [];
  const headers = { 'Authorization': SIMPLEAPI_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const rolLimpio = String(rol).trim();
  const comunaLimpia = String(comuna).trim();

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

  const esErrorComunas = (r) => {
    if (!r) return false;
    const msg = JSON.stringify(r).toLowerCase();
    return r.__status >= 400 && msg.includes('error al obtener comunas');
  };

  let resultado = null;
  let listaComunas = cacheComunas.lista;

  const bodyDirecto = JSON.stringify({ comuna: comunaLimpia, manzana, predio });
  for (let intento = 1; intento <= 2 && !resultado; intento++) {
    const r = await intentar(URL, { method: 'POST', headers, body: bodyDirecto }, debug, 'POST directo (intento ' + intento + ')');
    if (r && r.__status === 200) { resultado = r; break; }
    if (r && Array.isArray(r.data) && r.data.some(x => x.Comuna || x.comuna)) {
      listaComunas = r.data; cacheComunas.lista = listaComunas;
      break;
    }
    if (r && (r.__status === 503 || /under construction/i.test(JSON.stringify(r)))) {
      return res.json({ ok: false, mensaje: '🔧 El servicio de SimpleAPI esta caido en este momento (su servidor muestra "Site Under Construction"). No es un problema de tu plataforma ni de tu cuota. Reintenta en un rato, o usa los botones manuales Avaluo SII / Mapa SII.', debug });
    }
    if (esErrorComunas(r)) { await sleep(4000); continue; }
    if (r && r.__status === 401) {
      const cuerpo = JSON.stringify(r).toLowerCase();
      const esCuota = cuerpo.includes('l\u00edmite') || cuerpo.includes('limite');
      return res.json({ ok: false, mensaje: esCuota
        ? 'SimpleAPI: limite de consultas alcanzado en tu plan (modulo Mapas). Espera unos minutos y reintenta; si persiste, revisa el saldo/plan de tu cuenta en simpleapi.cl. Mientras, usa los botones manuales Avaluo SII / Mapa SII.'
        : 'SimpleAPI rechazo la API key (401). Revisa SIMPLEAPI_KEY en Railway.', debug });
    }
    break;
  }

  if (!resultado && Array.isArray(listaComunas)) {
    const objetivo = norm(comunaLimpia);
    let found = listaComunas.find(x => norm(x.Comuna || x.comuna || x.Nombre || x.nombre) === objetivo)
             || listaComunas.find(x => norm(x.Comuna || x.comuna || x.Nombre || x.nombre).includes(objetivo));
    let corregidoDe = null;
    if (!found && objetivo.length >= 4) {
      let mejor = null, mejorDist = Infinity;
      for (const x of listaComunas) {
        const nombreX = norm(x.Comuna || x.comuna || x.Nombre || x.nombre);
        const d = distanciaLevenshtein(objetivo, nombreX);
        if (d < mejorDist) { mejorDist = d; mejor = x; }
      }
      if (mejor && mejorDist <= 2 && mejorDist / objetivo.length <= 0.25) {
        found = mejor; corregidoDe = objetivo;
      }
    }
    const comunaId = found && (found.Id || found.id || found.ID || found.Codigo || found.codigo);
    const comunaNombre = found && (found.Comuna || found.comuna || found.Nombre || found.nombre);
    debug.push({ label: 'comuna-resuelta', comunaId: comunaId || 'NO ENCONTRADA', comunaNombre: comunaNombre || '-', buscado: objetivo, totalComunas: listaComunas.length,
      correccionAutomatica: corregidoDe ? ('"' + corregidoDe + '" no existe; se uso la comuna mas parecida: "' + comunaNombre + '"') : null });

    const bodies = [];
    if (comunaNombre) bodies.push({ comuna: comunaNombre, manzana, predio });
    if (comunaId !== undefined && comunaId !== null) bodies.push({ comuna: comunaId, manzana, predio });
    for (const b of bodies) {
      await sleep(2000);
      const r = await intentar(URL, { method: 'POST', headers, body: JSON.stringify(b) }, debug, 'POST ' + JSON.stringify(b));
      if (r && r.__status === 200) { resultado = r; if (corregidoDe) resultado.__comunaCorregida = comunaNombre; break; }
    }
  }

  if (!resultado) {
    const huboTransitorio = debug.some(d => (d.snippet || '').toLowerCase().includes('error al obtener comunas'));
    const mensaje = huboTransitorio
      ? 'SimpleAPI no logro consultar el SII en este momento (fallo temporal de su lado). Espera 1-2 minutos y vuelve a intentar. Si persiste, usa los botones manuales.'
      : 'Ninguna ruta respondio con datos. Revisa el detalle.';
    return res.json({ ok: false, mensaje, debug });
  }

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

// ════════════════════════════════════════════════════════════
// 4. CONSULTAR INIA
// ════════════════════════════════════════════════════════════
app.post('/consultar-inia', async (req, res) => {
  try {
    const { cultivo, comuna, region, contexto } = req.body || {};
    if (!cultivo) return res.status(400).json({ ok: false, mensaje: 'Falta indicar el cultivo a consultar.' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, mensaje: 'Falta ANTHROPIC_API_KEY en el servidor.' });

    const prompt = `Necesito informacion tecnica AGRONOMICA OFICIAL sobre el cultivo de "${cultivo}" en Chile, para una zona especifica.

Comuna: ${comuna || '(no especificada)'}
Región: ${region || '(no especificada)'}
${contexto ? 'Contexto adicional del predio (suelo/clima ya medidos): ' + contexto : ''}

Busca en publicaciones OFICIALES de INIA (Instituto de Investigaciones Agropecuarias de Chile): boletines tecnicos, informativos, "Tierra Adentro", estudios de zonificación agroclimática, o el sitio del centro regional INIA correspondiente a esa región (por ejemplo INIA Rayentué para O'Higgins, INIA La Platina para Metropolitana, etc.), disponibles en biblioteca.inia.cl o inia.cl.

Busca especificamente:
- Si INIA recomienda o ha estudiado este cultivo para esa zona/región.
- Variedades recomendadas por INIA para la zona, si las hay.
- Requerimientos agroclimáticos que INIA reporte (horas frío, riesgo de helada, tipo de suelo) para este cultivo.
- Cualquier boletín técnico o informativo relevante.

Reglas estrictas:
- Solo usa fuentes de inia.cl o biblioteca.inia.cl. No inventes recomendaciones ni cites estudios que no puedas encontrar realmente.
- Si no encuentras informacion especifica de INIA para esta combinacion cultivo+zona, dilo claramente: no completes con conocimiento general no verificado como si fuera de INIA.
- Cita SIEMPRE la URL de la fuente especifica que uses (no solo la portada de inia.cl).

Responde EXCLUSIVAMENTE con un JSON (sin texto antes ni despues, sin \`\`\`), con esta forma exacta:
{"encontrado":true|false,"resumen":"...","variedadesRecomendadas":"...","requerimientos":"...","fuenteUrl":"...","fuenteNombre":"...","fechaPublicacion":"..."}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error (consultar-inia):', response.status, errText);
      return res.status(502).json({ ok: false, mensaje: 'Error de la API de Claude al consultar.', detail: errText.substring(0, 500) });
    }

    const data = await response.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
    const fuentesConsultadas = (data.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (Array.isArray(b.content) ? b.content : []))
      .map(r => r && r.url).filter(Boolean);

    const resultado = extraerJSON(texto);
    if (!resultado) {
      return res.json({ ok: false, mensaje: 'La consulta no devolvio una respuesta interpretable (o se corto por longitud).', fuentesConsultadas });
    }

    if (!resultado.encontrado) {
      return res.json({ ok: true, encontrado: false,
        mensaje: 'No se encontró información específica de INIA para "' + cultivo + '" en esta zona. Prueba con el nombre del cultivo en español simple, o consulta directamente con el centro regional INIA correspondiente.',
        fuentesConsultadas });
    }

    const fuenteUrl = String(resultado.fuenteUrl || '').trim();
    const fuenteValida = /(^|\.)inia\.cl(\/|$)/i.test(fuenteUrl.replace(/^https?:\/\//, ''));
    if (!fuenteValida) {
      return res.json({ ok: true, encontrado: false,
        mensaje: 'La búsqueda no encontró una fuente oficial de inia.cl verificable para esta consulta.',
        fuentesConsultadas });
    }

    return res.json({
      ok: true, encontrado: true,
      resumen: String(resultado.resumen || '').trim(),
      variedadesRecomendadas: String(resultado.variedadesRecomendadas || '').trim(),
      requerimientos: String(resultado.requerimientos || '').trim(),
      fuenteUrl, fuenteNombre: String(resultado.fuenteNombre || '').trim(),
      fechaPublicacion: String(resultado.fechaPublicacion || '').trim(),
      fuentesConsultadas
    });
  } catch (err) {
    console.error('Error en /consultar-inia:', err);
    res.status(500).json({ ok: false, mensaje: 'Error del servidor: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
// 5. INFRAESTRUCTURA ELECTRICA CERCANA
// ════════════════════════════════════════════════════════════
const ENERGIA_ARCGIS = 'https://arcgis2.minenergia.cl/public/rest/services/IDE_ENERGIA/IDE_2019/FeatureServer';
app.post('/energia-cercana', async (req, res) => {
  const debug = [];
  try {
    const { lat, lon } = req.body || {};
    const latN = parseFloat(String(lat || '').replace(',', '.'));
    const lonN = parseFloat(String(lon || '').replace(',', '.'));
    if (!isFinite(latN) || !isFinite(lonN)) return res.status(400).json({ ok: false, mensaje: 'Faltan coordenadas del predio (lat/lon).' });

    const radios = [15000, 40000, 80000];
    const capas = [
      { id: 8, nombre: 'Línea de Transmisión', campo: 'lineaTransmision' },
      { id: 9, nombre: 'Subestación', campo: 'subestacion' }
    ];
    const resultado = {};

    for (const capa of capas) {
      let encontrado = null;
      for (const radio of radios) {
        try {
          const url = ENERGIA_ARCGIS + '/' + capa.id + '/query?f=json&geometry=' + lonN + ',' + latN +
            '&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects' +
            '&distance=' + radio + '&units=esriSRUnit_Meter&outFields=*&returnGeometry=true&outSR=4326';
          const r = await fetch(url, { timeout: 15000 });
          const j = await r.json();
          debug.push({ capa: capa.nombre, radio, status: r.status, features: j && j.features ? j.features.length : 0, error: j && j.error });
          if (j && Array.isArray(j.features) && j.features.length) {
            let mejor = null;
            j.features.forEach(f => {
              try {
                const punto2 = turf.point([lonN, latN]);
                let dKm = null;
                if (f.geometry && Array.isArray(f.geometry.paths)) {
                  f.geometry.paths.forEach(path => {
                    if (!path || path.length < 2) return;
                    try {
                      const d = turf.pointToLineDistance(punto2, turf.lineString(path), { units: 'kilometers' });
                      if (dKm === null || d < dKm) dKm = d;
                    } catch (eL) {}
                  });
                } else if (f.geometry && Array.isArray(f.geometry.rings)) {
                  f.geometry.rings.forEach(ring => {
                    if (!ring || ring.length < 3) return;
                    try {
                      const d = turf.pointToLineDistance(punto2, turf.lineString([...ring, ring[0]]), { units: 'kilometers' });
                      if (dKm === null || d < dKm) dKm = d;
                    } catch (eL) {}
                  });
                } else if (f.geometry && f.geometry.x !== undefined) {
                  dKm = turf.distance(punto2, turf.point([f.geometry.x, f.geometry.y]), { units: 'kilometers' });
                }
                if (dKm === null || isNaN(dKm)) return;
                if (!mejor || dKm < mejor.distanciaKm) mejor = { distanciaKm: Math.round(dKm * 100) / 100, atributos: f.attributes || {} };
              } catch (eF) {}
            });
            if (mejor) { encontrado = mejor; break; }
          }
        } catch (eR) { debug.push({ capa: capa.nombre, radio, error: eR.message }); }
      }
      resultado[capa.campo] = encontrado
        ? { distanciaKm: encontrado.distanciaKm, nombre: encontrado.atributos.Nombre || encontrado.atributos.NOMBRE || encontrado.atributos.name || '', voltaje: encontrado.atributos.Tension || encontrado.atributos.TENSION || encontrado.atributos.voltage || '' }
        : null;
    }

    res.json({
      ok: true,
      lineaTransmision: resultado.lineaTransmision,
      subestacion: resultado.subestacion,
      nota: 'La distancia es una medición geográfica real. NO indica si esa línea o subestación tiene capacidad disponible para inyectar energía: eso requiere consultar los estudios de capacidad de la distribuidora o del Coordinador Eléctrico Nacional (coordinador.cl).',
      fuente: 'Ministerio de Energía — Infraestructura Energética (IDE_ENERGIA), servicio público arcgis2.minenergia.cl',
      debug
    });
  } catch (err) {
    console.error('Error en /energia-cercana:', err);
    res.status(500).json({ ok: false, mensaje: 'Error del servidor: ' + err.message, debug });
  }
});

// ════════════════════════════════════════════════════════════
// 6. CONSULTAR NORMATIVA SOLAR
// ════════════════════════════════════════════════════════════
app.post('/consultar-normativa-solar', async (req, res) => {
  try {
    const { comuna, region, claseSuelo } = req.body || {};
    if (!comuna) return res.status(400).json({ ok: false, mensaje: 'Falta la comuna del predio.' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, mensaje: 'Falta ANTHROPIC_API_KEY en el servidor.' });

    const prompt = `Necesito saber si un predio agrícola en Chile puede destinarse a la instalación de paneles solares (proyecto fotovoltaico), desde el punto de vista NORMATIVO/REGULATORIO.

Comuna: ${comuna}
Región: ${region || '(no especificada)'}
${claseSuelo ? 'Clase de capacidad de uso del suelo (CIREN): ' + claseSuelo : ''}

Busca en fuentes OFICIALES chilenas: SAG (permisos para construcciones ajenas a la agricultura en área rural), Superintendencia de Electricidad y Combustibles (SEC), Comisión Nacional de Energía (CNE), Ministerio de Energía, Servicio de Evaluación Ambiental (SEIA), o el Plan Regulador Comunal de esa comuna si es pertinente.

Busca específicamente si existe alguna restricción o trámite requerido para instalar proyectos fotovoltaicos en suelo de uso agrícola en Chile.

Reglas estrictas sobre las fuentes:
- Solo usa fuentes gubernamentales oficiales (.gob.cl, .cl de organismos públicos). No inventes una regla genérica no verificada.
- Si no encuentras normativa específica, dilo claramente. NO derives una conclusión de "sí" o "no" a partir de la clase de suelo por tu cuenta: eso sería un criterio inventado, no verificado.
- Cita cada fuente real que uses, con su URL exacta.

Reglas estrictas sobre CÓMO REDACTAR la respuesta — esto es MUY IMPORTANTE porque lo va a leer una persona sin formación legal, que necesita entenderlo a la primera lectura, no un abogado:
- NO uses lenguaje legal, ni cites artículos de ley por número dentro del texto, ni encadenes fuentes dentro de la misma oración (nada de "según el Art. 55° de la LGUC y la Circular N°296...").
- Escribe como si le explicaras la situación a un colega en una conversación: frases cortas, directas, sin tecnicismos innecesarios.
- Estructura la respuesta en dos partes separadas: (1) un resumen breve de la situación en 2-4 frases simples, y (2) un listado de pasos concretos y accionables que la persona debe seguir en la práctica, en orden.
- Los nombres de trámites o instituciones sí puedes mencionarlos (ej. "SAG", "permiso IFC"), pero explica en una frase simple qué es cada uno la primera vez que lo nombras.
- Todas las referencias legales (números de ley, circulares, artículos) van SOLO en el arreglo de fuentes, nunca mezcladas dentro del resumen o los pasos.

Responde EXCLUSIVAMENTE con un JSON (sin texto antes ni despues, sin \`\`\`), con esta forma exacta:
{"encontrado":true|false,"resumen":"...","pasos":["...","..."],"fuentes":[{"nombre":"...","url":"...","fecha":"..."}]}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error (consultar-normativa-solar):', response.status, errText);
      return res.status(502).json({ ok: false, mensaje: 'Error de la API de Claude al consultar.', detail: errText.substring(0, 500) });
    }

    const data = await response.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
    const fuentesConsultadas = (data.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (Array.isArray(b.content) ? b.content : []))
      .map(r => r && r.url).filter(Boolean);

    const resultado = extraerJSON(texto);
    if (!resultado) return res.json({ ok: false, mensaje: 'La consulta no devolvió una respuesta interpretable (o se cortó por longitud). Reintenta; si persiste, la consulta es muy compleja para el límite de tokens.', fuentesConsultadas });

    if (!resultado.encontrado) {
      return res.json({ ok: true, encontrado: false,
        mensaje: 'No se encontró normativa específica y verificable para esta comuna. Consulta directamente con la SEC, la CNE o un abogado especializado en energía antes de avanzar con un proyecto solar.',
        fuentesConsultadas });
    }
    const fuentesCrudas = Array.isArray(resultado.fuentes) ? resultado.fuentes : [];
    const fuentes = fuentesCrudas
      .filter(f => f && /\.gob\.cl(\/|$)|coordinador\.cl(\/|$)/i.test(String(f.url || '').trim().replace(/^https?:\/\//, '')))
      .map(f => ({ nombre: String(f.nombre || '').trim(), url: String(f.url || '').trim(), fecha: String(f.fecha || '').trim() }));
    const pasos = Array.isArray(resultado.pasos) ? resultado.pasos.map(p => String(p || '').trim()).filter(Boolean) : [];

    if (!fuentes.length) {
      return res.json({ ok: true, encontrado: false, mensaje: 'La búsqueda no encontró una fuente gubernamental oficial verificable.', fuentesConsultadas });
    }
    res.json({ ok: true, encontrado: true, resumen: String(resultado.resumen || '').trim(), pasos, fuentes, fuentesConsultadas });
  } catch (err) {
    console.error('Error en /consultar-normativa-solar:', err);
    res.status(500).json({ ok: false, mensaje: 'Error del servidor: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
// 7. BUSCAR COMPARABLES DE MERCADO
// ════════════════════════════════════════════════════════════
app.post('/buscar-comparables', async (req, res) => {
  try {
    const { comuna, region, superficieObjetivo } = req.body || {};
    if (!comuna) return res.status(400).json({ ok: false, mensaje: 'Falta la comuna del predio.' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, mensaje: 'Falta ANTHROPIC_API_KEY en el servidor.' });

    const sup = parseFloat(String(superficieObjetivo || '0').replace(',', '.')) || 0;
    const rangoTxt = sup > 0 ? ('Busca preferentemente predios de tamaño similar, entre ' + Math.round(sup * 0.3) + ' y ' + Math.round(sup * 3) + ' hectáreas aproximadamente (el predio en tasación tiene ' + sup + ' ha).') : '';

    const prompt = `Necesito encontrar OFERTAS VIGENTES (publicadas ahora mismo) de campos o predios agrícolas EN VENTA, para usar como referencias de mercado en una tasación agrícola profesional en Chile.

Comuna del predio en tasación: ${comuna}
Región: ${region || '(no especificada)'}
${rangoTxt}

Busca en estos portales y corredores (y otros similares de propiedades agrícolas en Chile si los encuentras):
- portalinmobiliario.com (sección Campos/Terrenos agrícolas)
- colliers.cl o colliers.com (Chile, agrícola)
- gpsproperty.cl (sección Agrícola)
- Otros corredores especializados en campos agrícolas chilenos (ej. Tattersall Campos, Ipropiedadesagricolas, Aqueveque Propiedades, etc.)

Busca ofertas EN LA MISMA COMUNA o en comunas VECINAS de la misma región (prioriza cercanía geográfica real). Busca hasta 6 ofertas distintas si existen.

Para cada oferta que encuentres, extrae SOLO lo que está publicado explícitamente:
- Nombre/referencia de la oferta o corredor
- Ubicación (comuna/sector)
- Superficie en hectáreas
- Precio total (o precio por hectárea si es lo único publicado)
- URL directa de la publicación

Reglas estrictas:
- NUNCA inventes ni estimes un precio o superficie que no esté publicado explícitamente. Si el precio dice "Consultar" o no está publicado, indícalo así, no lo omitas ni lo inventes.
- No repitas la misma propiedad dos veces.
- Cada oferta debe tener su URL real y verificable.
- Si no encuentras ninguna oferta real y vigente, dilo claramente: no inventes ofertas de relleno.

Responde EXCLUSIVAMENTE con un JSON (sin texto antes ni despues, sin \`\`\`), con esta forma exacta:
{"encontrado":true|false,"ofertas":[{"oferta":"...","ubicacion":"...","superficieHa":"...","precioTotal":"...","precioHa":"...","url":"...","fuente":"..."}]}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error (buscar-comparables):', response.status, errText);
      return res.status(502).json({ ok: false, mensaje: 'Error de la API de Claude al buscar.', detail: errText.substring(0, 500) });
    }

    const data = await response.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
    const fuentesConsultadas = (data.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (Array.isArray(b.content) ? b.content : []))
      .map(r => r && r.url).filter(Boolean);

    const resultado = extraerJSON(texto);
    if (!resultado) {
      return res.json({ ok: false, mensaje: 'La búsqueda no devolvió una respuesta interpretable (o se cortó por longitud).', fuentesConsultadas });
    }

    const ofertasCrudas = Array.isArray(resultado.ofertas) ? resultado.ofertas : [];
    const ofertas = ofertasCrudas
      .filter(o => o && String(o.url || '').trim().startsWith('http'))
      .slice(0, 6)
      .map(o => ({
        oferta: String(o.oferta || '').trim(),
        ubicacion: String(o.ubicacion || '').trim(),
        superficieHa: String(o.superficieHa || '').trim(),
        precioTotal: String(o.precioTotal || '').trim(),
        precioHa: String(o.precioHa || '').trim(),
        url: String(o.url || '').trim(),
        fuente: String(o.fuente || '').trim()
      }));

    if (!resultado.encontrado || !ofertas.length) {
      return res.json({ ok: true, encontrado: false,
        mensaje: 'No se encontraron ofertas vigentes verificables para ' + comuna + '. Prueba ampliando a una comuna vecina, o agrega referencias manualmente.',
        fuentesConsultadas });
    }

    return res.json({ ok: true, encontrado: true, ofertas, fechaConsulta: new Date().toISOString().substring(0, 10), fuentesConsultadas });
  } catch (err) {
    console.error('Error en /buscar-comparables:', err);
    res.status(500).json({ ok: false, mensaje: 'Error del servidor: ' + err.message });
  }
});
