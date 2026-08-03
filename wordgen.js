// ============================================================================
//  wordgen.js — Generador de informes de tasacion en Word NATIVO (.docx)
//  Farm Brokers Chile
//
//  Recibe los "bloques" que el frontend serializa desde el informe ya
//  renderizado en pantalla (seccion, subtitulo, parrafo, tabla, imagen, etc.)
//  y los convierte en elementos nativos de Word. De esta forma el Word no
//  depende del diseno HTML: cualquier cambio futuro en el informe fluye solo.
// ============================================================================

const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, ShadingType, VerticalAlign,
  Header, Footer, PageNumber, PageBreak, LevelFormat, convertMillimetersToTwip
} = require('docx');

// ── Paleta de marca (misma del informe en pantalla) ──────────────────────────
const VERDE   = '33463B';
const ORO     = 'C6A66A';
const TINTA   = '222724';
const GRIS    = '6C746F';
const HUESO   = 'F7F5F1';
const LINEA   = 'E2E4E1';
const VERDE_CLARO = 'C9D3CC';

const FUENTE = 'Georgia';        // titulos y numeros
const TEXTO  = 'Calibri';        // cuerpo

// A4 con los margenes del informe: 2,0 arriba / 1,8 laterales / 2,2 abajo
const MARGEN = { top: convertMillimetersToTwip(20), right: convertMillimetersToTwip(18),
                 bottom: convertMillimetersToTwip(22), left: convertMillimetersToTwip(18) };
// Ancho util = 21,0 - 1,8 - 1,8 = 17,4 cm  (1 cm = 567 twips)
const ANCHO = Math.round(174 * 56.7);   // 9866 twips

const SIN_BORDE = { top:{style:BorderStyle.NONE,size:0,color:'FFFFFF'}, bottom:{style:BorderStyle.NONE,size:0,color:'FFFFFF'},
                    left:{style:BorderStyle.NONE,size:0,color:'FFFFFF'}, right:{style:BorderStyle.NONE,size:0,color:'FFFFFF'},
                    insideHorizontal:{style:BorderStyle.NONE,size:0,color:'FFFFFF'}, insideVertical:{style:BorderStyle.NONE,size:0,color:'FFFFFF'} };

// ── Utilidades ───────────────────────────────────────────────────────────────
const limpio = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

// Celda sin bordes con relleno de color (Word pinta el fondo de forma continua,
// que es justamente lo que el HTML no lograba)
function celda(hijos, { fill, ancho, colSpan, alinearV = VerticalAlign.CENTER, margen } = {}) {
  return new TableCell({
    children: hijos,
    columnSpan: colSpan,
    verticalAlign: alinearV,
    width: ancho ? { size: ancho, type: WidthType.DXA } : undefined,
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    borders: SIN_BORDE,
    margins: margen,
  });
}

function tablaLibre(filas, columnWidths) {
  return new Table({
    rows: filas,
    width: { size: ANCHO, type: WidthType.DXA },
    columnWidths,
    borders: SIN_BORDE,
    layout: 'fixed',
  });
}

// Dimensiones reales de una imagen base64 (para conservar la proporcion)
function medirImagen(buf) {
  try {
    // PNG
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), tipo: 'png' };
    }
    // JPEG: recorrer marcadores hasta un SOF
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), tipo: 'jpg' };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return { w: 1200, h: 800, tipo: 'jpg' };
    }
  } catch (e) {}
  return { w: 1200, h: 800, tipo: 'png' };
}

function dataUriABuffer(src) {
  const m = /^data:([^;]+);base64,(.*)$/i.exec(String(src || ''));
  if (!m) return null;
  return { buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

// ── Bloques ──────────────────────────────────────────────────────────────────

// Banda de seccion: filete dorado + numero + titulo, todo en una fila continua
function bloqueSeccion(b) {
  const conNum = !!limpio(b.num);
  const anchos = conNum ? [57, 624, ANCHO - 681] : [57, ANCHO - 57];
  const celdas = [celda([new Paragraph({ children: [new TextRun({ text: '', size: 2 })] })], { fill: ORO, ancho: anchos[0] })];
  if (conNum) {
    celdas.push(celda([new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: limpio(b.num), bold: true, size: 28, color: ORO, font: FUENTE })],
    })], { fill: VERDE, ancho: anchos[1], margen: { top: 140, bottom: 140, left: 60, right: 60 } }));
  }
  const dentro = [new Paragraph({
    spacing: { before: 0, after: limpio(b.sub) ? 40 : 0 },
    children: [new TextRun({ text: limpio(b.titulo).toUpperCase(), bold: true, size: 23, color: 'FFFFFF', font: FUENTE, characterSpacing: 24 })],
  })];
  if (limpio(b.sub)) {
    dentro.push(new Paragraph({
      spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: limpio(b.sub), italics: true, size: 16, color: VERDE_CLARO, font: TEXTO })],
    }));
  }
  celdas.push(celda(dentro, { fill: VERDE, ancho: anchos[anchos.length - 1], margen: { top: 150, bottom: 150, left: 200, right: 160 } }));
  return [tablaLibre([new TableRow({ children: celdas })], anchos),
          new Paragraph({ spacing: { after: 200 }, children: [] })];
}

// Subtitulo: linea dorada corta + texto en versalitas (como el <Sub> en pantalla)
function bloqueSub(b) {
  return [new Paragraph({
    spacing: { before: 280, after: 100 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORO, space: 4 } },
    children: [new TextRun({ text: limpio(b.x).toUpperCase(), bold: true, size: 19, color: VERDE, font: FUENTE, characterSpacing: 20 })],
  })];
}

function bloqueParrafo(b) {
  return [new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 60, after: 140, line: 300 },
    children: [new TextRun({ text: limpio(b.x), size: 21, color: TINTA, font: TEXTO })],
  })];
}

function bloqueNota(b) {
  return [new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 40, after: 120, line: 280 },
    children: [new TextRun({ text: limpio(b.x), italics: true, size: 17, color: GRIS, font: TEXTO })],
  })];
}

function bloquePie(b) {   // pie de figura
  return [new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 40, after: 180 },
    children: [new TextRun({ text: limpio(b.x), italics: true, size: 16, color: GRIS, font: TEXTO })],
  })];
}

// Campo etiqueta / valor
function bloqueCampo(b) {
  return [new Paragraph({
    spacing: { before: 0, after: 0, line: 260 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINEA, space: 2 } },
    children: [
      new TextRun({ text: limpio(b.k).toUpperCase() + ':  ', bold: true, size: 15, color: VERDE, font: FUENTE, characterSpacing: 14 }),
      new TextRun({ text: limpio(b.v), size: 21, color: TINTA, font: TEXTO }),
    ],
  })];
}

// Indicador destacado (cifra grande + etiqueta)
function bloqueKpi(b) {
  const fila = new TableRow({ children: [celda([
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 20 },
      children: [new TextRun({ text: limpio(b.v), bold: true, size: 26, color: VERDE, font: FUENTE })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: limpio(b.k).toUpperCase(), size: 14, color: GRIS, font: TEXTO, characterSpacing: 18 })] }),
  ], { fill: HUESO, ancho: ANCHO, margen: { top: 120, bottom: 120, left: 120, right: 120 } })] });
  return [tablaLibre([fila], [ANCHO]), new Paragraph({ spacing: { after: 100 }, children: [] })];
}

// Lista numerada o con vinetas
function bloqueLista(b) {
  return (b.items || []).map(it => new Paragraph({
    numbering: { reference: b.ord ? 'lista-num' : 'lista-vin', level: 0 },
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 30, after: 60, line: 280 },
    children: [new TextRun({ text: limpio(it), size: 20, color: TINTA, font: TEXTO })],
  }));
}

// Tabla de datos: encabezado verde con texto blanco, filas alternadas, totales en negrita
function bloqueTabla(b) {
  const heads = (b.head || []).map(limpio);
  const rows = (b.rows || []).map(r => (r || []).map(limpio));
  const nCols = Math.max(heads.length, ...rows.map(r => r.length), 1);
  const primeraAncha = nCols > 2 ? 1.9 : 1.4;   // la 1a columna suele llevar nombres largos
  const unidad = Math.floor(ANCHO / (nCols - 1 + primeraAncha));
  const anchos = Array.from({ length: nCols }, (_, i) => i === 0 ? ANCHO - unidad * (nCols - 1) : unidad);
  const nBold = b.boldLast || 0;

  const filas = [];
  if (heads.length) {
    filas.push(new TableRow({
      tableHeader: true,
      children: heads.map((h, i) => celda([new Paragraph({
        alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: h.toUpperCase(), bold: true, size: 15, color: 'FFFFFF', font: FUENTE, characterSpacing: 16 })],
      })], { fill: VERDE, ancho: anchos[i], margen: { top: 110, bottom: 110, left: 110, right: 110 } })),
    }));
  }
  rows.forEach((r, i) => {
    const destacada = nBold > 0 && i >= rows.length - nBold;
    const fondo = destacada ? HUESO : (i % 2 === 0 ? 'FFFFFF' : 'FBFAF7');
    const celdas = [];
    for (let j = 0; j < nCols; j++) {
      celdas.push(celda([new Paragraph({
        alignment: j === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 250 },
        children: [new TextRun({ text: r[j] || '', size: 19, bold: destacada, color: destacada ? VERDE : TINTA, font: TEXTO })],
      })], { fill: fondo, ancho: anchos[j], margen: { top: 90, bottom: 90, left: 110, right: 110 } }));
    }
    filas.push(new TableRow({ children: celdas }));
  });

  const tabla = new Table({
    rows: filas,
    width: { size: ANCHO, type: WidthType.DXA },
    columnWidths: anchos,
    layout: 'fixed',
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: LINEA },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: LINEA },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
  });
  return [tabla, new Paragraph({ spacing: { after: 160 }, children: [] })];
}

// Imagen: se ajusta al ancho util conservando proporcion, con tope de alto
function bloqueImagen(b) {
  const d = dataUriABuffer(b.src);
  if (!d) return [];
  const { w, h, tipo } = medirImagen(d.buf);
  const MAX_W = 640;                       // puntos (~17,4 cm)
  const MAX_H = b.alto === 'alto' ? 560 : 420;
  let ancho = MAX_W, alto = Math.round(MAX_W * h / w);
  if (alto > MAX_H) { alto = MAX_H; ancho = Math.round(MAX_H * w / h); }
  const ext = /jpe?g/i.test(d.mime) ? 'jpg' : (/gif/i.test(d.mime) ? 'gif' : 'png');
  return [new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 60 },
    children: [new ImageRun({ data: d.buf, type: ext, transformation: { width: ancho, height: alto } })],
  })];
}

// ── Portada ──────────────────────────────────────────────────────────────────
function portada(meta) {
  const hijos = [];
  const logo = dataUriABuffer(meta.logoBlanco);
  if (logo) {
    const { w, h } = medirImagen(logo.buf);
    const ancho = 150, alto = Math.round(150 * h / w);
    hijos.push(new Paragraph({
      spacing: { before: 0, after: 260 },
      children: [new ImageRun({ data: logo.buf, type: /jpe?g/i.test(logo.mime) ? 'jpg' : 'png',
                                transformation: { width: ancho, height: alto } })],
    }));
  }
  hijos.push(new Paragraph({
    spacing: { before: 0, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ORO, space: 1 } },
    children: [new TextRun({ text: '        ', size: 2 })],
  }));
  hijos.push(new Paragraph({
    spacing: { before: 160, after: 200 },
    children: [new TextRun({ text: 'INFORME DE TASACIÓN', size: 17, color: VERDE_CLARO, font: TEXTO, characterSpacing: 48 })],
  }));
  hijos.push(new Paragraph({
    spacing: { before: 0, after: 220 },
    children: [new TextRun({ text: limpio(meta.predioNombre), bold: true, size: 50, color: 'FFFFFF', font: FUENTE })],
  }));
  (meta.roles || []).forEach(r => {
    hijos.push(new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [new TextRun({ text: 'Rol N° ' + limpio(r.rol) + (r.comuna ? '  ·  ' + limpio(r.comuna) : ''), size: 19, color: VERDE_CLARO, font: TEXTO })],
    }));
  });
  if (limpio(meta.region)) {
    hijos.push(new Paragraph({
      spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: limpio(meta.region), size: 19, color: VERDE_CLARO, font: TEXTO })],
    }));
  }

  const bloque = [
    // filete dorado superior
    tablaLibre([new TableRow({ children: [celda([new Paragraph({ children: [new TextRun({ text: '', size: 2 })] })], { fill: ORO, ancho: ANCHO })] })], [ANCHO]),
    // panel verde
    tablaLibre([new TableRow({ children: [celda(hijos, { fill: VERDE, ancho: ANCHO, alinearV: VerticalAlign.TOP,
      margen: { top: 800, bottom: 700, left: 620, right: 620 } })] })], [ANCHO]),
    new Paragraph({ spacing: { after: 320 }, children: [] }),
  ];

  // Datos del encargo, en columnas (como en la vista previa)
  const metas = [
    [meta.numTasacion ? 'N° ' + limpio(meta.numTasacion) : '', 'Informe'],
    [limpio(meta.fecha), 'Fecha de tasación'],
    [limpio(meta.solicitante), 'Preparado para'],
    [limpio(meta.superficie), 'Superficie SII'],
  ].filter(x => x[0]);
  if (metas.length) {
    const anchoCol = Math.floor(ANCHO / metas.length);
    const anchos = metas.map((_, i) => i === metas.length - 1 ? ANCHO - anchoCol * (metas.length - 1) : anchoCol);
    bloque.push(tablaLibre([new TableRow({
      children: metas.map((x, i) => celda([
        new Paragraph({ spacing: { before: 0, after: 40 },
          children: [new TextRun({ text: x[1].toUpperCase(), size: 13, color: GRIS, font: TEXTO, characterSpacing: 20 })] }),
        new Paragraph({ spacing: { before: 0, after: 0 },
          children: [new TextRun({ text: x[0], bold: true, size: 22, color: TINTA, font: FUENTE })] }),
      ], { ancho: anchos[i], alinearV: VerticalAlign.TOP, margen: { top: 0, bottom: 0, left: 0, right: 200 } })),
    })], anchos));
  }

  bloque.push(new Paragraph({
    spacing: { before: 420, after: 0 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINEA, space: 8 } },
    children: [
      new TextRun({ text: 'FARM BROKERS CHILE', bold: true, size: 15, color: VERDE, font: FUENTE }),
      new TextRun({ text: '  ·  Tasaciones · Estudios · Venta de Campos', size: 15, color: GRIS, font: TEXTO }),
      new TextRun({ text: '\t\t\t\twww.farmbrokers.cl', size: 15, color: GRIS, font: TEXTO }),
    ],
  }));
  bloque.push(new Paragraph({ children: [new PageBreak()] }));
  return bloque;
}

// ── Documento completo ───────────────────────────────────────────────────────
function generarDocx(bloques, meta = {}) {
  const hijos = portada(meta);
  let primeraSeccion = true;

  (bloques || []).forEach(b => {
    if (!b || !b.t) return;
    switch (b.t) {
      case 'seccion':
        if (!primeraSeccion) hijos.push(new Paragraph({ children: [new PageBreak()] }));
        primeraSeccion = false;
        hijos.push(...bloqueSeccion(b));
        break;
      case 'sub':    hijos.push(...bloqueSub(b));     break;
      case 'p':      hijos.push(...bloqueParrafo(b)); break;
      case 'nota':   hijos.push(...bloqueNota(b));    break;
      case 'cap':    hijos.push(...bloquePie(b));     break;
      case 'campo':  hijos.push(...bloqueCampo(b));   break;
      case 'kpi':    hijos.push(...bloqueKpi(b));     break;
      case 'lista':  hijos.push(...bloqueLista(b));   break;
      case 'tabla':  hijos.push(...bloqueTabla(b));   break;
      case 'img':    hijos.push(...bloqueImagen(b));  break;
      default: break;
    }
  });

  const pie = new Footer({
    children: [new Paragraph({
      spacing: { before: 0, after: 0 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINEA, space: 6 } },
      children: [
        new TextRun({ text: 'Farm Brokers Chile · Tasaciones, Estudios y Venta de Campos', size: 14, color: GRIS, font: TEXTO }),
        new TextRun({ text: meta.numTasacion ? '   ·   Informe N° ' + limpio(meta.numTasacion) : '', size: 14, color: GRIS, font: TEXTO }),
        new TextRun({ text: '\t\t', size: 14 }),
        new TextRun({ text: 'Pág. ', size: 14, color: GRIS, font: TEXTO }),
        new TextRun({ children: [PageNumber.CURRENT], size: 14, color: GRIS, font: TEXTO }),
        new TextRun({ text: ' de ', size: 14, color: GRIS, font: TEXTO }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: GRIS, font: TEXTO }),
      ],
    })],
  });

  const doc = new Document({
    creator: 'Farm Brokers Chile',
    numbering: { config: [
      { reference: 'lista-num', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
      { reference: 'lista-vin', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
    ] },
    title: 'Informe de Tasación' + (meta.predioNombre ? ' — ' + limpio(meta.predioNombre) : ''),
    description: 'Informe de tasación generado por la plataforma Farm Brokers Chile',
    styles: { default: { document: { run: { font: TEXTO, size: 21, color: TINTA } } } },
    sections: [{
      properties: { page: { margin: MARGEN } },
      footers: { default: pie },
      children: hijos,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generarDocx };
