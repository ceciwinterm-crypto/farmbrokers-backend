// Servidor backend para Farm Brokers - Plataforma de Tasaciones
// Recibe datos del predio y genera textos profesionales usando Claude API

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors()); // Permite que la plataforma web se conecte
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
AGUA: ${datos.cn1} (${datos.ca1} acciones, ${datos.cq1} l/s) | ${datos.cn2} (${datos.ca2} acciones)
PLANTACIONES: ${datos.plantacionDesc} (${datos.plantacionHas} ha)
CONSTRUCCIONES: ${datos.construcciones}
COORDENADAS: ${datos.coordLat} S, ${datos.coordLon} O | DISTANCIA SANTIAGO: ${datos.distSantiago} km
ACCESO: ${datos.acceso}

Genera exactamente este JSON con 8 campos. Cada campo es un string con texto corrido profesional:
resumen: 3 oraciones describiendo el predio, ubicacion y uso actual
ubicacion: 2 oraciones con coordenadas, distancia a Santiago y acceso
titulos: 1 parrafo sobre inscripcion en CBR y deslindes
suelos: 1 parrafo sobre clasificacion de suelos segun SII
ciren: 1 parrafo con caracteristicas de la serie de suelo segun CIREN
clima: 2 parrafos sobre clima mediterraneo semiarido de la zona
hidrico: 1 parrafo sobre derechos de aprovechamiento de aguas
conclusiones: 4 parrafos de conclusiones profesionales de tasacion

IMPORTANTE: Responde UNICAMENTE con el objeto JSON. Sin texto antes ni despues. Sin bloques de codigo.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: instruccion }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return res.status(502).json({ error: 'Error de la API de Claude', detail: errText });
    }

    const data = await response.json();
    const text = (data.content || []).map(c => c.text || '').join('').trim();

    let jsonStr = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ error: 'Respuesta de IA no contenia JSON valido', raw: text });
    }

    const ia = JSON.parse(match[0]);
    res.json({ ia });

  } catch (err) {
    console.error('Error en /generar-informe:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Farm Brokers corriendo en puerto ${PORT}`);
});
