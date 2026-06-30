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
SUELOS: Clase I ${datos.c1} ha, II ${datos.c2} ha, III ${datos.c3} ha, IV ${datos.c4} ha
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
      console.error('JSON intentado (primeros 1000 chars):', match[0].substring(0, 1000));
      return res.status(500).json({
        error: 'El JSON generado por la IA estaba mal formado: ' + parseErr.message,
        raw: match[0].substring(0, 1000)
      });
    }

    const camposEsperados = ['resumen', 'ubicacion', 'titulos', 'suelos', 'ciren', 'clima', 'hidrico', 'conclusiones'];
    const faltantes = camposEsperados.filter(c => !ia[c]);
    if (faltantes.length > 0) {
      console.warn('Campos faltantes en la respuesta:', faltantes);
    }

    res.json({ ia });

  } catch (err) {
    console.error('Error en /generar-informe:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Farm Brokers corriendo en puerto ${PORT}`);
});
