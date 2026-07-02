// Servidor backend para Farm Brokers - Plataforma de Tasaciones
// Recibe datos del predio y genera textos profesionales usando Claude API

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: Falta la variable de entorno ANTHROPIC_API_KEY');
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Farm Brokers Tasacion API' });
});

app.post('/generar-informe', async (req, res) => {
  try {
    const datos = req.body;

    if (!datos.predioNombre) {
      return res.status(400).json({ error: 'Falta el nombre del predio' });
    }

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

    if (data.stop_reason === 'max_tokens') {
      console.error('Respuesta truncada por max_tokens');
    }

    const text = (data.content || []).map(c => c.text || '').join('').trim();
    console.log('Respuesta cruda de Claude (primeros 500 chars):', text.substring(0, 500));

    let jsonStr = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = jsonStr.match(/\{[\s\S]*\}/);

    if (!match) {
      console.error('No se encontro JSON en la respuesta. Texto completo:', text);
      return res.status(500).json({ error: 'Respuesta de IA no contenia JSON valido', raw: text.substring(0, 1000) });
    }

    let ia;
    try {
      ia = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error('Error parseando JSON:', parseErr.message);
      return res.status(500).json({
        error: 'El JSON generado por la IA estaba mal formado: ' + parseErr.message,
        raw: match[0].substring(0, 1000)
      });
    }

    res.json({ ia });

  } catch (err) {
    console.error('Error en /generar-informe:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Busqueda automatica de datos por rol en SII (integracion no oficial) ───
const normTxt = s => (s||'').toString().trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

async function tryFetch(url, opts, debug, label){
  try{
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type')||'';
    const body = await r.text();
    debug.push({label, url, status: r.status, ct, snippet: body.substring(0, 250)});
    try{ return JSON.parse(body); }catch(e){ return {__html: body, __status: r.status}; }
  }catch(e){
    debug.push({label, url, error: e.message});
    return null;
  }
}

app.post('/buscar-rol', async (req, res) => {
  const { rol, comuna } = req.body || {};
  if(!rol || !comuna) return res.status(400).json({ ok:false, error:'Faltan rol y comuna' });

  const debug = [];
  const base = 'https://www4.sii.cl/mapasui/services/data/mapasFacadeService/';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www4.sii.cl/mapasui/internet/'
  };

  let comunasResp = await tryFetch(base + 'obtenerComunas', { headers }, debug, 'comunas-GET');
  if(!comunasResp || comunasResp.__html){
    comunasResp = await tryFetch(base + 'obtenerComunas', { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:'{}' }, debug, 'comunas-POST');
  }
  let lista = Array.isArray(comunasResp) ? comunasResp
    : (comunasResp && (comunasResp.data || comunasResp.comunas || comunasResp.listaComunas)) || null;

  let codComuna = null;
  if(Array.isArray(lista)){
    const target = normTxt(comuna);
    const found = lista.find(x => normTxt(x.nombre || x.NOMBRE || x.descripcion || x.nombreComuna || x.comuna || '') === target);
    if(found) codComuna = found.codigo ?? found.CODIGO ?? found.id ?? found.codComuna ?? found.codigoComuna ?? found.cod;
    debug.push({label:'comuna-resuelta', codComuna, totalComunas: lista.length});
  }

  const partes = String(rol).split('-').map(s => s.trim().replace(/\D/g,''));
  const manzana = partes[0] || '';
  const predio = partes[1] || '';

  const intentos = [];
  if(codComuna){
    intentos.push({label:'roles-GET', url: base + 'obtenerRoles?comuna=' + codComuna + '&manzana=' + manzana + '&predio=' + predio, opts:{ headers }});
    intentos.push({label:'predio-GET', url: base + 'obtenerPredio?comuna=' + codComuna + '&manzana=' + manzana + '&predio=' + predio, opts:{ headers }});
    intentos.push({label:'predioRol-POST', url: base + 'obtenerPredioPorRol', opts:{ method:'POST', headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ comuna: codComuna, manzana, predio }) }});
    intentos.push({label:'buscarPredio-POST', url: base + 'buscarPredio', opts:{ method:'POST', headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ codigoComuna: codComuna, rol: manzana + '-' + predio }) }});
  }
  intentos.push({label:'buscarPredio-GET', url: base + 'buscarPredio?comuna=' + encodeURIComponent(comuna) + '&rol=' + manzana + '-' + predio, opts:{ headers }});

  let datos = null;
  for(const a of intentos){
    const r = await tryFetch(a.url, a.opts, debug, a.label);
    if(r && !r.__html){
      const cand = Array.isArray(r) ? r[0] : (r.data || r.predio || r.resultado || r);
      if(cand && typeof cand === 'object'){
        const tiene = ['avaluo','AVALUO','avaluoTotal','superficie','SUPERFICIE','superficieTerreno','destino','DESTINO','direccion','DIRECCION']
          .some(k => cand[k] !== undefined);
        if(tiene){ datos = cand; break; }
      }
    }
  }

  if(!datos){
    return res.json({ ok:false, codComuna, debug });
  }

  const g = (o, ...keys) => { for(const k of keys){ if(o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; } return ''; };

  let lat = g(datos,'lat','latitud','LATITUD','y','coordY');
  let lon = g(datos,'lng','lon','longitud','LONGITUD','x','coordX');

  res.json({
    ok: true,
    codComuna,
    datos: {
      avaluoFiscal: String(g(datos,'avaluo','AVALUO','avaluoTotal','avaluototal','avaluoFiscal')),
      superficie: String(g(datos,'superficie','SUPERFICIE','superficieTerreno','supTerreno','supPredio')),
      destino: String(g(datos,'destino','DESTINO','destinoPredio','uso')),
      direccion: String(g(datos,'direccion','DIRECCION','direccionPredio')),
      lat: String(lat), lon: String(lon)
    },
    raw: datos,
    debug
  });
});

app.listen(PORT, () => {
  console.log(`Servidor Farm Brokers corriendo en puerto ${PORT}`);
});
