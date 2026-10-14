#!/usr/bin/env node
// Migración sin pérdida: completa "quién lo creó" y "quién lo modificó" en los
// registros que ya existían (campos, clientes y tasaciones del CRM, y tasaciones
// de la plataforma), tomando esos datos de su historial.
// Antes de tocar nada deja una copia completa con fecha. Se puede ejecutar varias
// veces: solo completa lo que falta.
// Uso (en la consola de Railway): node scripts/migrar-autores.cjs
const fs = require('fs');
const path = require('path');
const RAIZ = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'datos-locales');
const marca = new Date().toISOString().replace(/[:.]/g, '-');
let cambios = 0;

// 1) CRM
const ARCH = path.join(RAIZ, 'crm', 'crm.json');
if (fs.existsSync(ARCH)) {
  fs.copyFileSync(ARCH, `${ARCH}.antes-usuarios-${marca}`);
  const db = JSON.parse(fs.readFileSync(ARCH, 'utf8'));
  for (const col of ['campos', 'clientes', 'tasaciones']) for (const x of db[col] || []) {
    const h = x.historial || [];
    if (!x.creadoPor && h[0] && h[0].autor) { x.creadoPor = h[0].autor; cambios++; }
    const u = h[h.length - 1];
    if (!x.modificadoPor && u && u.autor) { x.modificadoPor = u.autor; x.modificado = u.fecha; cambios++; }
  }
  const tmp = `${ARCH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, ARCH);
  console.log(`✓ CRM: copia en crm.json.antes-usuarios-${marca}`);
} else console.log('· No se encontró el CRM en', ARCH);

// 2) Tasaciones de la plataforma
const DIR = path.join(RAIZ, 'tasaciones');
if (fs.existsSync(DIR)) {
  const respaldo = path.join(RAIZ, `tasaciones-antes-usuarios-${marca}`);
  fs.mkdirSync(respaldo, { recursive: true });
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    const ruta = path.join(DIR, f);
    fs.copyFileSync(ruta, path.join(respaldo, f));
    const r = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!r.creadoPor) { r.creadoPor = 'Antes de los usuarios'; r.creado = r.creado || r.guardado; cambios++; }
    if (!r.modificadoPor) { r.modificadoPor = 'Antes de los usuarios'; cambios++; }
    const tmp = `${ruta}.tmp`; fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, ruta);
  }
  console.log(`✓ Tasaciones: copia en ${path.basename(respaldo)}`);
}
console.log(`✓ Listo: ${cambios} datos completados. No se borró nada.`);
