// ============================================================================
//  wordgen.js — Informe de tasacion en Word NATIVO (.docx)
//  Farm Brokers Chile — diseño editorial
//
//  Recibe los "bloques" que el frontend serializa desde el informe renderizado
//  (seccion, subtitulo, parrafo, tabla, imagen...) y los arma como elementos
//  nativos de Word: portada con imagen, encabezado y pie en cada pagina,
//  bandas de seccion, indicadores pareados y cajas de advertencia.
// ============================================================================

const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, ShadingType, VerticalAlign,
  Header, Footer, PageNumber, PageBreak, LevelFormat, convertMillimetersToTwip
} = require('docx');

// ── Paleta ──────────────────────────────────────────────────────────────────
const VERDE   = '263D33';   // verde profundo de las bandas
const ORO     = 'C5A66A';   // dorado de acento
const CREMA   = 'EEE8DC';   // fondo de indicadores y avisos
const CREMA_L = 'FAF8F4';   // fondo suave alterno
const VERDE_L = 'E9EEE9';   // verde muy claro
const TINTA   = '222724';
const GRIS    = '6C746F';
const LINEA   = 'DCDDD9';

const F = 'Calibri';        // una sola familia, como el modelo

const MARGEN = { top: convertMillimetersToTwip(18), right: convertMillimetersToTwip(19),
                 bottom: convertMillimetersToTwip(18), left: convertMillimetersToTwip(19),
                 header: convertMillimetersToTwip(10), footer: convertMillimetersToTwip(10) };
const ANCHO = Math.round(172 * 56.7);   // ancho util en twips

const SIN_BORDE = {
  top:{style:BorderStyle.NONE,size:0,color:'FFFFFF'}, bottom:{style:BorderStyle.NONE,size:0,color:'FFFFFF'},
  left:{style:BorderStyle.NONE,size:0,color:'FFFFFF'}, right:{style:BorderStyle.NONE,size:0,color:'FFFFFF'},
  insideHorizontal:{style:BorderStyle.NONE,size:0,color:'FFFFFF'}, insideVertical:{style:BorderStyle.NONE,size:0,color:'FFFFFF'} };

const limpio = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

function celda(hijos, { fill, ancho, colSpan, alinearV = VerticalAlign.CENTER, margen } = {}) {
  return new TableCell({
    children: hijos, columnSpan: colSpan, verticalAlign: alinearV,
    width: ancho ? { size: ancho, type: WidthType.DXA } : undefined,
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    borders: SIN_BORDE, margins: margen,
  });
}
const tablaLibre = (filas, columnWidths) => new Table({
  rows: filas, width: { size: ANCHO, type: WidthType.DXA },
  columnWidths, borders: SIN_BORDE, layout: 'fixed' });

const vacio = (after = 0) => new Paragraph({ spacing: { after }, children: [] });

// ── Imagenes ────────────────────────────────────────────────────────────────
function medirImagen(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) {}
  return { w: 1200, h: 800 };
}
function dataUriABuffer(src) {
  const m = /^data:([^;]+);base64,(.*)$/i.exec(String(src || ''));
  return m ? { buf: Buffer.from(m[2], 'base64'), mime: m[1] } : null;
}
const tipoImg = mime => /jpe?g/i.test(mime) ? 'jpg' : (/gif/i.test(mime) ? 'gif' : 'png');

// ── Bandas de seccion: bloque dorado + numero + titulo a la derecha ─────────
function bloqueSeccion(b) {
  const num = limpio(b.num), titulo = limpio(b.titulo), sub = limpio(b.sub);
  const wOro = Math.round(ANCHO * 0.28);
  const wNum = Math.round(ANCHO * 0.16);
  const wTxt = ANCHO - wOro - wNum;

  const dentro = [new Paragraph({
    alignment: AlignmentType.RIGHT, spacing: { before: 0, after: sub ? 40 : 0 },
    children: [new TextRun({ text: titulo.toUpperCase(), bold: true, size: 27, color: 'FFFFFF', font: F })],
  })];
  if (sub) dentro.push(new Paragraph({
    alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 },
    children: [new TextRun({ text: sub, italics: true, size: 17, color: 'C9D3CC', font: F })],
  }));

  return [
    tablaLibre([new TableRow({ children: [
      celda([vacio()], { fill: ORO, ancho: wOro }),
      celda([new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: num, bold: true, size: 34, color: ORO, font: F })],
      })], { fill: VERDE, ancho: wNum, margen: { top: 220, bottom: 220, left: 60, right: 60 } }),
      celda(dentro, { fill: VERDE, ancho: wTxt, margen: { top: 220, bottom: 220, left: 120, right: 220 } }),
    ] })], [wOro, wNum, wTxt]),
    vacio(240),
  ];
}

// ── Indicadores: se muestran de a dos por fila, como en el modelo ──────────
function filaKpis(pareja) {
  const w = Math.round(ANCHO / 2);
  const cel = k => celda([
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 30 },
      children: [new TextRun({ text: limpio(k.v), bold: true, size: 30, color: VERDE, font: F })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: limpio(k.k).toUpperCase(), size: 15, color: GRIS, font: F, characterSpacing: 16 })] }),
  ], { fill: CREMA_L, ancho: w, margen: { top: 190, bottom: 190, left: 120, right: 120 } });
  const celdas = pareja.map(cel);
  if (celdas.length === 1) celdas.push(celda([vacio()], { fill: CREMA_L, ancho: w }));
  return [tablaLibre([new TableRow({ children: celdas })], [w, ANCHO - w]), vacio(120)];
}

// ── Aviso: bloque dorado a la izquierda y texto en cursiva ──────────────────
function bloqueAviso(b) {
  const wOro = Math.round(ANCHO * 0.30), wTxt = ANCHO - wOro;
  return [
    tablaLibre([new TableRow({ children: [
      celda([vacio()], { fill: ORO, ancho: wOro }),
      celda([new Paragraph({
        alignment: AlignmentType.JUSTIFIED, spacing: { before: 0, after: 0, line: 280 },
        children: [new TextRun({ text: limpio(b.x), italics: true, size: 19, color: TINTA, font: F })],
      })], { fill: CREMA, ancho: wTxt, margen: { top: 170, bottom: 170, left: 170, right: 170 } }),
    ] })], [wOro, wTxt]),
    vacio(200),
  ];
}

// ── Bloques simples ─────────────────────────────────────────────────────────
const bloqueSub = b => [new Paragraph({
  spacing: { before: 300, after: 120 },
  children: [new TextRun({ text: limpio(b.x).toUpperCase(), bold: true, size: 22, color: VERDE, font: F, characterSpacing: 12 })],
})];

const bloqueParrafo = b => [new Paragraph({
  alignment: AlignmentType.JUSTIFIED, spacing: { before: 60, after: 160, line: 300 },
  children: [new TextRun({ text: limpio(b.x), size: 21, color: TINTA, font: F })],
})];

const bloquePie = b => [new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 60, after: 200 },
  children: [new TextRun({ text: limpio(b.x), italics: true, size: 17, color: GRIS, font: F })],
})];

const bloqueCampo = b => [new Paragraph({
  spacing: { before: 0, after: 0, line: 280 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINEA, space: 3 } },
  children: [
    new TextRun({ text: limpio(b.k).toUpperCase() + '   ', bold: true, size: 16, color: VERDE, font: F, characterSpacing: 12 }),
    new TextRun({ text: limpio(b.v), size: 21, color: TINTA, font: F }),
  ],
})];

const bloqueLista = b => (b.items || []).map(it => new Paragraph({
  numbering: { reference: b.ord ? 'lista-num' : 'lista-vin', level: 0 },
  alignment: AlignmentType.JUSTIFIED, spacing: { before: 40, after: 80, line: 290 },
  children: [new TextRun({ text: limpio(it), size: 21, color: TINTA, font: F })],
}));

// ── Tablas de datos ─────────────────────────────────────────────────────────
function bloqueTabla(b) {
  const heads = (b.head || []).map(limpio);
  const rows = (b.rows || []).map(r => (r || []).map(limpio));
  const nCols = Math.max(heads.length, ...rows.map(r => r.length), 1);
  const primera = nCols > 2 ? 1.9 : 1.4;
  const unidad = Math.floor(ANCHO / (nCols - 1 + primera));
  const anchos = Array.from({ length: nCols }, (_, i) => i === 0 ? ANCHO - unidad * (nCols - 1) : unidad);
  const nBold = b.boldLast || 0;
  const filas = [];

  if (heads.length) filas.push(new TableRow({
    tableHeader: true, cantSplit: false,
    children: heads.map((h, i) => celda([new Paragraph({
      alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: h.toUpperCase(), bold: true, size: 17, color: 'FFFFFF', font: F, characterSpacing: 12 })],
    })], { fill: VERDE, ancho: anchos[i], margen: { top: 130, bottom: 130, left: 120, right: 120 } })),
  }));

  rows.forEach((r, i) => {
    const destacada = nBold > 0 && i >= rows.length - nBold;
    const fondo = destacada ? CREMA : (i % 2 === 0 ? 'FFFFFF' : CREMA_L);
    const celdas = [];
    for (let j = 0; j < nCols; j++) celdas.push(celda([new Paragraph({
      alignment: j === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, spacing: { before: 0, after: 0, line: 260 },
      children: [new TextRun({ text: r[j] || '', size: 20, bold: destacada, color: destacada ? VERDE : TINTA, font: F })],
    })], { fill: fondo, ancho: anchos[j], margen: { top: 110, bottom: 110, left: 120, right: 120 } }));
    filas.push(new TableRow({ children: celdas, cantSplit: false }));
  });

  return [new Table({
    rows: filas, width: { size: ANCHO, type: WidthType.DXA }, columnWidths: anchos, layout: 'fixed',
    borders: { ...SIN_BORDE, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: LINEA },
               bottom: { style: BorderStyle.SINGLE, size: 4, color: LINEA } },
  }), vacio(200)];
}

// ── Imagenes del cuerpo ─────────────────────────────────────────────────────
function bloqueImagen(b) {
  const d = dataUriABuffer(b.src);
  if (!d) return [];
  const { w, h } = medirImagen(d.buf);
  const MAX_W = 620;
  const MAX_H = b.alto === 'doc' ? 880 : (b.alto === 'alto' ? 540 : 400);
  let ancho = MAX_W, alto = Math.round(MAX_W * h / w);
  if (alto > MAX_H) { alto = MAX_H; ancho = Math.round(MAX_H * w / h); }
  return [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 140, after: 60 },
    children: [new ImageRun({ data: d.buf, type: tipoImg(d.mime), transformation: { width: ancho, height: alto } })],
  })];
}

// ── Portada: panel verde con el titulo + imagen del predio al costado ───────
function portada(meta) {
  const hijos = [];
  const logo = dataUriABuffer(meta.logoBlanco);
  if (logo) {
    const { w, h } = medirImagen(logo.buf);
    hijos.push(new Paragraph({ spacing: { after: 420 },
      children: [new ImageRun({ data: logo.buf, type: tipoImg(logo.mime),
        transformation: { width: 128, height: Math.round(128 * h / w) } })] }));
  }
  hijos.push(new Paragraph({ spacing: { after: 130 },
    children: [new TextRun({ text: 'INFORME DE TASACIÓN', size: 16, color: 'C9D3CC', font: F, characterSpacing: 30 })] }));
  hijos.push(new Paragraph({ spacing: { after: 200, line: 300 },
    children: [new TextRun({ text: limpio(meta.predioNombre), bold: true, size: 40, color: 'FFFFFF', font: F })] }));
  (meta.roles || []).forEach(r => hijos.push(new Paragraph({ spacing: { after: 50 },
    children: [new TextRun({ text: 'Rol N° ' + limpio(r.rol) + (r.comuna ? '   ·   ' + limpio(r.comuna) : ''),
      bold: true, size: 19, color: 'FFFFFF', font: F })] })));
  if (limpio(meta.region)) hijos.push(new Paragraph({ spacing: { after: 0 },
    children: [new TextRun({ text: limpio(meta.region), size: 18, color: 'C9D3CC', font: F })] }));

  const foto = dataUriABuffer(meta.fotoPortada);
  const wIzq = foto ? Math.round(ANCHO * 0.56) : ANCHO;
  const filaSup = [celda(hijos, { fill: VERDE, ancho: wIzq, alinearV: VerticalAlign.TOP,
    margen: { top: 560, bottom: 560, left: 460, right: 380 } })];
  if (foto) {
    const { w, h } = medirImagen(foto.buf);
    const anchoPt = 210, altoPt = 300;                       // recuadro vertical al costado
    const esc = Math.max(anchoPt / w, altoPt / h);            // cubre el recuadro sin deformar
    filaSup.push(celda([new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      children: [new ImageRun({ data: foto.buf, type: tipoImg(foto.mime),
        transformation: { width: Math.round(w * esc), height: Math.round(h * esc) } })],
    })], { fill: VERDE, ancho: ANCHO - wIzq, alinearV: VerticalAlign.CENTER, margen: { top: 0, bottom: 0, left: 0, right: 0 } }));
  }

  const bloque = [
    tablaLibre([new TableRow({ children: filaSup })], foto ? [wIzq, ANCHO - wIzq] : [ANCHO]),
    vacio(320),
    new Paragraph({ spacing: { after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ORO, space: 1 } },
      children: [new TextRun({ text: '', size: 2 })] }),
  ];

  const metas = [
    [meta.numTasacion ? 'N° ' + limpio(meta.numTasacion) : '', 'Informe'],
    [limpio(meta.fecha), 'Fecha de tasación'],
    [limpio(meta.solicitante), 'Preparado para'],
    [limpio(meta.superficie), 'Superficie SII'],
  ].filter(x => x[0]);
  if (metas.length) {
    const wCol = Math.floor(ANCHO / metas.length);
    const anchos = metas.map((_, i) => i === metas.length - 1 ? ANCHO - wCol * (metas.length - 1) : wCol);
    bloque.push(tablaLibre([new TableRow({
      children: metas.map((x, i) => celda([
        new Paragraph({ spacing: { after: 50 },
          children: [new TextRun({ text: x[1].toUpperCase(), size: 14, color: GRIS, font: F, characterSpacing: 18 })] }),
        new Paragraph({ spacing: { after: 0 },
          children: [new TextRun({ text: x[0], bold: true, size: 21, color: TINTA, font: F })] }),
      ], { fill: CREMA_L, ancho: anchos[i], alinearV: VerticalAlign.TOP,
           margen: { top: 200, bottom: 200, left: i === 0 ? 200 : 140, right: 140 } })),
    })], anchos));
  }

  bloque.push(new Paragraph({
    alignment: AlignmentType.RIGHT, spacing: { before: 200 },
    children: [new TextRun({ text: 'TASACIONES   ·   ESTUDIOS   ·   VENTA DE CAMPOS',
      bold: true, size: 15, color: ORO, font: F, characterSpacing: 16 })],
  }));
  bloque.push(new Paragraph({ children: [new PageBreak()] }));
  return bloque;
}

// ── Documento ───────────────────────────────────────────────────────────────
function generarDocx(bloques, meta = {}) {
  const hijos = portada(meta);
  let primera = true;

  // Los indicadores se agrupan de a dos, como en el modelo
  const lista = bloques || [];
  for (let i = 0; i < lista.length; i++) {
    const b = lista[i];
    if (!b || !b.t) continue;
    if (b.t === 'kpi') {
      const par = [b];
      if (lista[i + 1] && lista[i + 1].t === 'kpi') { par.push(lista[i + 1]); i++; }
      hijos.push(...filaKpis(par));
      continue;
    }
    switch (b.t) {
      case 'seccion':
        if (!primera) hijos.push(new Paragraph({ children: [new PageBreak()] }));
        primera = false;
        hijos.push(...bloqueSeccion(b));
        break;
      case 'sub':   hijos.push(...bloqueSub(b));     break;
      case 'p':     hijos.push(...bloqueParrafo(b)); break;
      case 'nota':  hijos.push(...bloqueAviso(b));   break;
      case 'cap':   hijos.push(...bloquePie(b));     break;
      case 'campo': hijos.push(...bloqueCampo(b));   break;
      case 'lista': hijos.push(...bloqueLista(b));   break;
      case 'tabla': hijos.push(...bloqueTabla(b));   break;
      case 'img':   hijos.push(...bloqueImagen(b));  break;
      default: break;
    }
  }

  const encabezado = new Header({ children: [new Paragraph({
    spacing: { after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORO, space: 5 } },
    children: [
      new TextRun({ text: 'FARM BROKERS CHILE', bold: true, size: 14, color: TINTA, font: F, characterSpacing: 12 }),
      new TextRun({ text: '   ·   INFORME DE TASACIÓN', size: 14, color: GRIS, font: F, characterSpacing: 12 }),
      new TextRun({ text: meta.numTasacion ? '   ·   N° ' + limpio(meta.numTasacion) : '', size: 14, color: GRIS, font: F, characterSpacing: 12 }),
    ],
  })] });

  const pie = new Footer({ children: [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 0 },
    children: [
      new TextRun({ text: 'Tasaciones · Estudios · Venta de Campos    |    www.farmbrokers.cl    |    Pág. ', size: 14, color: GRIS, font: F }),
      new TextRun({ children: [PageNumber.CURRENT], size: 14, color: GRIS, font: F }),
      new TextRun({ text: ' de ', size: 14, color: GRIS, font: F }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: GRIS, font: F }),
    ],
  })] });

  const doc = new Document({
    creator: 'Farm Brokers Chile',
    title: 'Informe de Tasación' + (meta.predioNombre ? ' — ' + limpio(meta.predioNombre) : ''),
    numbering: { config: [
      { reference: 'lista-num', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
      { reference: 'lista-vin', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
    ] },
    styles: { default: { document: { run: { font: F, size: 21, color: TINTA } } } },
    sections: [{
      properties: { page: { margin: MARGEN }, titlePage: true },   // la portada va sin encabezado
      headers: { default: encabezado, first: new Header({ children: [] }) },
      footers: { default: pie, first: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'www.farmbrokers.cl', size: 15, color: GRIS, font: F })] })] }) },
      children: hijos,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generarDocx };
