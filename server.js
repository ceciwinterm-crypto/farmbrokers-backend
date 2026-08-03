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

// Extrae el primer objeto JSON BALANCEADO de un texto (cuenta llaves, respeta strings/escapes).
// Mas robusto que un regex "primera { a ultima }": si el texto de Claude trae explicaciones
// antes/despues del JSON, o si el JSON tiene objetos/arreglos anidados, esto encuentra el
// cierre real del primer objeto en vez de agarrar basura hasta la ultima llave del texto.
// Distancia de edicion (Levenshtein) entre dos strings: cuantas letras hay que cambiar/
// agregar/quitar para pasar de una a la otra. Se usa para detectar errores de tipeo en
// nombres de comuna (ej. "OVLLE" vs "OVALLE" = 1 letra de diferencia) sin adivinar a ciegas.
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
  return null; // nunca cerro: la respuesta se corto (truncada por max_tokens u otra causa)
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API v58 (fix: la clasificacion SII fiscal se lee de la capa Propiedades rurales de SIT Rural — CIREN no trae esos campos)', simpleapi: !!SIMPLEAPI_KEY });
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

// ──────────────── BUSQUEDA DE PROPIETARIO POR ROL (IA + busqueda web) ────────────────
// Usa el modelo con busqueda web activada para encontrar el "Rol de Avaluos" oficial
// que publican las municipalidades (el mismo tipo de documento SII/gobierno que se uso
// para verificar Mahuidanche y El Portal). NUNCA se usa como dato final: siempre queda
// marcado como "verificar manualmente" y siempre se exige la URL fuente para poder revisarlo.
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
{"encontrado":true|false,"propietario":"...","nombrePredio":"...","fuenteUrl":"...","fuenteNombre":"...","fechaDocumento":"...","esEmpresa":true|false,"rut":"...","rutFuenteUrl":"...","rutFuenteNombre":"...","notaIncertidumbre":"..."}

Si encontrado es false, deja los demas campos como "" o false.
"notaIncertidumbre" es para que menciones cualquier duda (ej. "hay otra empresa con nombre muy similar", "el documento es de 2018 y podria estar desactualizado", "no se encontro coincidencia exacta de RUT").`;

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
    // El texto final puede venir repartido en varios bloques (busquedas intermedias + respuesta final)
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
    // Fuentes que el modelo efectivamente consulto (para mostrar trazabilidad aunque el JSON falle)
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

    // ── Segunda capa de seguridad (no depender solo del prompt): ──
    // solo se entrega RUT si el nombre del propietario realmente PARECE una empresa.
    // Si no calza el patron, se descarta el RUT aunque el modelo lo haya devuelto.
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

// ──────────────── CONSULTA PUNTUAL A INIA (IA + busqueda web, un cultivo a la vez) ────────────────
// Busca en publicaciones OFICIALES de INIA (biblioteca.inia.cl, inia.cl) recomendaciones
// tecnicas para un cultivo especifico en una zona especifica. Es una consulta puntual,
// a pedido: nunca se ejecuta automaticamente en cada informe. Siempre exige fuente citable
// y se presenta como informativa, no como sustituto de asesoria agronomica en terreno.
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
{"encontrado":true|false,"resumen":"...","variedadesRecomendadas":"...","requerimientos":"...","fuenteUrl":"...","fuenteNombre":"...","fechaPublicacion":"..."}

Si encontrado es false, deja los demas campos como "".
"resumen" debe ser un parrafo breve (3-5 lineas) parafraseado, no una copia literal del texto original.`;

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

    // Solo se acepta como fuente valida un dominio de INIA (segunda capa de seguridad, no depender solo del prompt)
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

// ──────────────── INFRAESTRUCTURA ELECTRICA CERCANA (ArcGIS publico Min. Energia) ────────────────
// Consulta el servicio geografico PUBLICO del Ministerio de Energia (IDE_ENERGIA) y calcula
// la distancia real desde el punto del predio a la linea de transmision y a la subestacion
// mas cercanas. Esto es una MEDICION GEOGRAFICA real (no requiere cuenta ni clave), pero
// NO equivale a "capacidad disponible para inyectar energia": eso depende de estudios de
// capacidad que publican las distribuidoras y el Coordinador Electrico Nacional, y no es
// un dato que se pueda derivar de la distancia. Esto se aclara siempre en la respuesta.
const ENERGIA_ARCGIS = 'https://arcgis2.minenergia.cl/public/rest/services/IDE_ENERGIA/IDE_2019/FeatureServer';
app.post('/energia-cercana', async (req, res) => {
  const debug = [];
  try {
    const { lat, lon } = req.body || {};
    const latN = parseFloat(String(lat || '').replace(',', '.'));
    const lonN = parseFloat(String(lon || '').replace(',', '.'));
    if (!isFinite(latN) || !isFinite(lonN)) return res.status(400).json({ ok: false, mensaje: 'Faltan coordenadas del predio (lat/lon).' });

    // Radio de busqueda: se amplia progresivamente si no encuentra nada cerca (predios rurales
    // pueden estar lejos de la red). 15 km -> 40 km -> 80 km.
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
            // Calcular distancia real a cada feature encontrada y quedarse con la mas cercana
            let mejor = null;
            j.features.forEach(f => {
              try {
                const punto2 = turf.point([lonN, latN]);
                let dKm = null;
                if (f.geometry && Array.isArray(f.geometry.paths)) {
                  // Cada "path" es un segmento de linea: se mide la distancia a cada uno y se toma la minima
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
      nota: 'La distancia es una medición geográfica real. NO indica si esa línea o subestación tiene capacidad disponible para inyect
