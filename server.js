// Servidor backend para Farm Brokers - Plataforma de Tasaciones v7

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
if (!SIMPLEAPI_KEY) console.warn('AVISO: Falta SIMPLEAPI_KEY (la busqueda por rol no funcionara)');

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API v7', simpleapi: !!SIMPLEAPI_KEY });
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

  const URL = SIMPLEAPI_URL || 'https://servicios.simpleapi.cl/api/mapas/buscar/rol';

  const partes = rolLimpio.split('-').map(s => s.trim());
  const manzana = partes[0] || '';
  const predio = partes[1] || '';

  const norm = s => (s||'').toString().trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

  let resultado = null;
  let listaComunas = cacheComunas.lista;
  let comunaId = null;

  if (!listaComunas) {
    const primer = await intentar(URL, { method: 'POST', headers, body: JSON.stringify({ comuna: comunaLimpia, manzana, predio }) }, debug, 'POST inicial');
    if (primer && primer.__status === 200) resultado = primer;
    if (primer && Array.isArray(primer.data) && primer.data.some(x => x.Comuna || x.comuna)) {
      listaComunas = primer.data;
      cacheComunas.lista = listaComunas;
    }
    await sleep(1300);
  }

  let comunaNombre = null;
  if (!resultado && Array.isArray(listaComunas)) {
    const objetivo = norm(comunaLimpia);
    const found = listaComunas.find(x => norm(x.Comuna || x.comuna) === objetivo);
    if (found) {
      comunaId = found.Id || found.id || found.ID;
      comunaNombre = found.Comuna || found.comuna;
    }
    debug.push({ label: 'comuna-resuelta', comunaId: comunaId || 'NO ENCONTRADA', comunaNombre: comunaNombre || '-',
