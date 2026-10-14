#!/usr/bin/env node
// Crea un usuario ADMINISTRADOR (o restablece su contraseña si ya existe).
// Uso (en la consola de Railway, dentro del servicio del backend):
//   node scripts/crear-admin.cjs correo@farmbrokers.cl "Nombre como aparece en el CRM"
// Luego pide la contraseña (mínimo 8 caracteres, con letras y números).
// También se puede pasar en la variable NUEVA_CLAVE para no escribirla en pantalla.
const readline = require('readline');
const path = require('path');
const auth = require(path.join(__dirname, '..', 'auth.js'));
const bcrypt = require('bcryptjs');

const [email, ...resto] = process.argv.slice(2);
const nombre = resto.join(' ');
if (!email || !nombre) { console.log('Uso: node scripts/crear-admin.cjs correo@dominio.cl "Nombre Apellido"'); process.exit(1); }

const pedir = (q) => new Promise((ok) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (r) => { rl.close(); ok(r); }); });
(async () => {
  const clave = process.env.NUEVA_CLAVE || await pedir('Contraseña para el administrador: ');
  const err = auth._interno.validarClave(clave); if (err) { console.log('✗', err); process.exit(1); }
  const r = await auth._interno.modificar((db) => {
    const u = db.usuarios.find((x) => x.email === String(email).trim().toLowerCase());
    if (u) { u.hash = bcrypt.hashSync(String(clave), 12); u.rol = 'admin'; u.activo = true; u.debeCambiarClave = false; return `Se actualizó a ${u.nombre} (${u.email}) como administrador y se cambió su contraseña.`; }
    const n = auth._interno.crearUsuario(db, { email, nombre, rol: 'admin', clave });
    return `Administrador creado: ${n.nombre} (${n.email}).`;
  });
  console.log('✓', r, '\nArchivo de usuarios:', auth._interno.ARCHIVO);
})().catch((e) => { console.log('✗', e.message); process.exit(1); });
