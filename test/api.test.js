// Pruebas de integración: levantan la API real contra una MongoDB temporal.
// Uso: MONGODB_URI=mongodb://127.0.0.1:27017 npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estadoPago, diasRestantes, fechaValida, hoyISO } from "../src/estados.js";

const RAIZ = process.env.API_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB = "cometa_test_" + Date.now();
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

let cliente, db, proc;
let tokenA, tokenB;

async function api(metodo, ruta, { token, body, raw } = {}) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: { ...(body !== undefined || raw ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

before(async () => {
  cliente = new MongoClient(URI);
  await cliente.connect();
  db = cliente.db(DB);
  const hash = await bcrypt.hash("clave1234", 4);
  await db.collection("entrenadores").insertMany([
    { entrenador_id: "E01", nombre: "Ana", apellido: "Ruiz", usuario: "ana", passwordHash: hash },
    { entrenador_id: "E02", nombre: "Beto", apellido: "Paz", usuario: "beto", passwordHash: hash },
  ]);
  proc = spawn("node", ["src/server.js"], {
    cwd: RAIZ,
    env: { ...process.env, PORT: String(PORT), MONGODB_URI: URI, DB_NAME: DB, JWT_SECRET: "secreto-de-prueba" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("La API no arrancó")), 15000);
    proc.stdout.on("data", (d) => { if (String(d).includes("escuchando")) { clearTimeout(t); ok(); } });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (c) => { clearTimeout(t); fail(new Error("La API terminó con código " + c)); });
  });
  tokenA = (await api("POST", "/api/auth/login", { body: { usuario: "ana", password: "clave1234" } })).json.token;
  tokenB = (await api("POST", "/api/auth/login", { body: { usuario: "beto", password: "clave1234" } })).json.token;
});

after(async () => {
  proc?.kill();
  await db?.dropDatabase();
  await cliente?.close();
});

// ---------------------------------------------------------------- LOGIN (punto 4)
test("login: credenciales correctas devuelven token", async () => {
  const r = await api("POST", "/api/auth/login", { body: { usuario: "ana", password: "clave1234" } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
});

test("login: contraseña incorrecta -> 401", async () => {
  const r = await api("POST", "/api/auth/login", { body: { usuario: "ana", password: "mala" } });
  assert.equal(r.status, 401);
});

test("login: sin cuerpo -> 400 (no 500)", async () => {
  const r = await api("POST", "/api/auth/login");
  assert.equal(r.status, 400);
});

test("login: cuerpo vacío {} -> 400", async () => {
  const r = await api("POST", "/api/auth/login", { body: {} });
  assert.equal(r.status, 400);
});

test("login: usuario no es texto (inyección NoSQL) -> 400", async () => {
  const r = await api("POST", "/api/auth/login", { body: { usuario: { $ne: null }, password: "clave1234" } });
  assert.equal(r.status, 400);
});

test("login: password no es texto -> 400", async () => {
  const r = await api("POST", "/api/auth/login", { body: { usuario: "ana", password: 12345 } });
  assert.equal(r.status, 400);
});

test("JSON malformado -> 400 (no 500)", async () => {
  const r = await api("POST", "/api/auth/login", { raw: "{esto no es json" });
  assert.equal(r.status, 400);
});

test("login: tras varios intentos fallidos se bloquea -> 429", async () => {
  let ultimo;
  for (let i = 0; i < 8; i++) ultimo = await api("POST", "/api/auth/login", { body: { usuario: "bloqueado", password: "x" } });
  assert.equal(ultimo.status, 429);
});

test("login: el bloqueo de un usuario no afecta a otro", async () => {
  const r = await api("POST", "/api/auth/login", { body: { usuario: "beto", password: "clave1234" } });
  assert.equal(r.status, 200);
});

test("rutas protegidas: sin token -> 401", async () => {
  assert.equal((await api("GET", "/api/perfil")).status, 401);
  assert.equal((await api("GET", "/api/categorias")).status, 401);
});

test("rutas protegidas: token falso -> 401", async () => {
  assert.equal((await api("GET", "/api/perfil", { token: "abc.def.ghi" })).status, 401);
});

// ---------------------------------------------------------------- PERFIL
test("perfil: GET devuelve datos sin passwordHash", async () => {
  const r = await api("GET", "/api/perfil", { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal(r.json.usuario, "ana");
  assert.equal(r.json.passwordHash, undefined);
});

test("perfil: PUT sin cuerpo -> 400", async () => {
  assert.equal((await api("PUT", "/api/perfil", { token: tokenA })).status, 400);
});

test("perfil: PUT con usuario repetido -> 409", async () => {
  const r = await api("PUT", "/api/perfil", { token: tokenA, body: { nombre: "Ana", apellido: "Ruiz", usuario: "beto" } });
  assert.equal(r.status, 409);
});

test("perfil: PUT válido -> 200", async () => {
  const r = await api("PUT", "/api/perfil", { token: tokenA, body: { nombre: "Ana M.", apellido: "Ruiz", usuario: "ana" } });
  assert.equal(r.status, 200);
});

test("perfil/password: actual incorrecta -> 401", async () => {
  const r = await api("PUT", "/api/perfil/password", { token: tokenA, body: { actual: "x", nueva: "nuevaclave" } });
  assert.equal(r.status, 401);
});

test("perfil/password: sin cuerpo -> 401/400 (no 500)", async () => {
  const r = await api("PUT", "/api/perfil/password", { token: tokenA });
  assert.ok([400, 401].includes(r.status));
});

test("perfil/password: nueva muy corta -> 400", async () => {
  const r = await api("PUT", "/api/perfil/password", { token: tokenA, body: { actual: "clave1234", nueva: "ab" } });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------- CATEGORÍAS / ÍTEMS / DEPORTISTAS (flujo base)
let catA, itemA, depA1, depA2;

test("categorías: crear y listar", async () => {
  const c = await api("POST", "/api/categorias", { token: tokenA, body: { nombre: "Temporada 2026" } });
  assert.equal(c.status, 201);
  catA = c.json.categoria_id;
  const l = await api("GET", "/api/categorias", { token: tokenA });
  assert.equal(l.status, 200);
  assert.ok(l.json.some((x) => x.categoria_id === catA));
});

test("categorías: nombre vacío -> 400", async () => {
  assert.equal((await api("POST", "/api/categorias", { token: tokenA, body: { nombre: "  " } })).status, 400);
  assert.equal((await api("POST", "/api/categorias", { token: tokenA })).status, 400);
});

test("deportistas: crear y listar", async () => {
  const a = await api("POST", "/api/deportistas", { token: tokenA, body: { nombre: "Luisa" } });
  const b = await api("POST", "/api/deportistas", { token: tokenA, body: { nombre: "Marta" } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  depA1 = a.json.deportista_id; depA2 = b.json.deportista_id;
  const l = await api("GET", "/api/deportistas", { token: tokenA });
  assert.equal(l.json.length, 2);
});

test("deportistas: nombre vacío -> 400", async () => {
  assert.equal((await api("POST", "/api/deportistas", { token: tokenA, body: {} })).status, 400);
});

test("ítems: crear genera un pago pendiente por deportista activo", async () => {
  const r = await api("POST", `/api/categorias/${catA}/items`, { token: tokenA, body: { nombre: "Mensualidad enero", valor: 50000 } });
  assert.equal(r.status, 201);
  itemA = r.json.item_id;
  assert.equal(r.json.valor, 50000);
  const p = await api("GET", `/api/items/${itemA}/pagos`, { token: tokenA });
  assert.equal(p.status, 200);
  assert.equal(p.json.deportistas.length, 2);
  assert.ok(p.json.deportistas.every((d) => d.pagado === false));
});

test("ítems: listar por categoría", async () => {
  const r = await api("GET", `/api/categorias/${catA}/items`, { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
});

test("ítems: nombre vacío -> 400 y categoría inexistente -> 404", async () => {
  assert.equal((await api("POST", `/api/categorias/${catA}/items`, { token: tokenA, body: {} })).status, 400);
  assert.equal((await api("POST", `/api/categorias/NOEXISTE/items`, { token: tokenA, body: { nombre: "x" } })).status, 404);
});

test("pagos: marcar y desmarcar", async () => {
  let r = await api("PATCH", `/api/items/${itemA}/pagos/${depA1}`, { token: tokenA, body: { pagado: true } });
  assert.equal(r.status, 200);
  let p = await api("GET", `/api/items/${itemA}/pagos`, { token: tokenA });
  const d = p.json.deportistas.find((x) => x.deportista_id === depA1);
  assert.equal(d.pagado, true);
  assert.ok(d.fecha_pago);
  r = await api("PATCH", `/api/items/${itemA}/pagos/${depA1}`, { token: tokenA, body: { pagado: false } });
  p = await api("GET", `/api/items/${itemA}/pagos`, { token: tokenA });
  assert.equal(p.json.deportistas.find((x) => x.deportista_id === depA1).fecha_pago, null);
});

test("pagos: 'pagado' no booleano -> 400; sin cuerpo -> 400", async () => {
  assert.equal((await api("PATCH", `/api/items/${itemA}/pagos/${depA1}`, { token: tokenA, body: { pagado: "si" } })).status, 400);
  assert.equal((await api("PATCH", `/api/items/${itemA}/pagos/${depA1}`, { token: tokenA })).status, 400);
});

test("pagos: deportista inexistente -> 404", async () => {
  assert.equal((await api("PATCH", `/api/items/${itemA}/pagos/D999`, { token: tokenA, body: { pagado: true } })).status, 404);
});

test("pagos: ítem inexistente -> 404", async () => {
  assert.equal((await api("GET", `/api/items/I999/pagos`, { token: tokenA })).status, 404);
});

// ---------------------------------------------------------------- AISLAMIENTO ENTRE ENTRENADORES (punto 1)
test("aislamiento: B no ve las categorías de A", async () => {
  const r = await api("GET", "/api/categorias", { token: tokenB });
  assert.equal(r.json.length, 0);
});

test("aislamiento: B no puede listar los ítems de la categoría de A", async () => {
  const r = await api("GET", `/api/categorias/${catA}/items`, { token: tokenB });
  assert.equal(r.status, 404);
});

test("aislamiento: B no puede ver los pagos de un ítem de A", async () => {
  const r = await api("GET", `/api/items/${itemA}/pagos`, { token: tokenB });
  assert.equal(r.status, 404);
});

test("aislamiento: B no puede marcar pagos de A", async () => {
  const r = await api("PATCH", `/api/items/${itemA}/pagos/${depA2}`, { token: tokenB, body: { pagado: true } });
  assert.equal(r.status, 404);
  const p = await api("GET", `/api/items/${itemA}/pagos`, { token: tokenA });
  assert.equal(p.json.deportistas.find((x) => x.deportista_id === depA2).pagado, false);
});

test("aislamiento: B no puede crear ítems en la categoría de A", async () => {
  const r = await api("POST", `/api/categorias/${catA}/items`, { token: tokenB, body: { nombre: "intruso" } });
  assert.equal(r.status, 404);
});

test("aislamiento: un deportista nuevo de B NO recibe pagos de ítems de A", async () => {
  const d = await api("POST", "/api/deportistas", { token: tokenB, body: { nombre: "Carlos" } });
  assert.equal(d.status, 201);
  const huérfanos = await db.collection("pagos").countDocuments({ deportista_id: d.json.deportista_id });
  assert.equal(huérfanos, 0);
  const l = await api("GET", `/api/items/${itemA}/pagos`, { token: tokenA });
  assert.equal(l.json.deportistas.length, 2);
});

test("aislamiento: B no ve los deportistas de A", async () => {
  const r = await api("GET", "/api/deportistas", { token: tokenB });
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].nombre, "Carlos");
});

test("aislamiento: un ítem de B sólo genera pagos para deportistas de B", async () => {
  const c = await api("POST", "/api/categorias", { token: tokenB, body: { nombre: "Torneos" } });
  const i = await api("POST", `/api/categorias/${c.json.categoria_id}/items`, { token: tokenB, body: { nombre: "Copa" } });
  const p = await api("GET", `/api/items/${i.json.item_id}/pagos`, { token: tokenB });
  assert.equal(p.json.deportistas.length, 1);
  assert.equal(p.json.deportistas[0].nombre, "Carlos");
});

// ---------------------------------------------------------------- IDs (punto 3)
test("ids: 20 deportistas creados en paralelo -> todos distintos", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => api("POST", "/api/deportistas", { token: tokenA, body: { nombre: "P" + i } })));
  assert.ok(rs.every((r) => r.status === 201), "todas deben responder 201");
  const ids = rs.map((r) => r.json.deportista_id);
  assert.equal(new Set(ids).size, 20, "ids duplicados: " + ids.join(","));
});

test("ids: pasar de D999 a D1000 funciona (orden numérico, no de texto)", async () => {
  await db.collection("deportistas").insertOne({ deportista_id: "D999", entrenador_id: "E01", nombre: "Tope", activo: true });
  await db.collection("counters").deleteMany({}); // simula una BD que aún no tenía contador
  const a = await api("POST", "/api/deportistas", { token: tokenA, body: { nombre: "Mil" } });
  const b = await api("POST", "/api/deportistas", { token: tokenA, body: { nombre: "MilUno" } });
  assert.equal(a.json.deportista_id, "D1000");
  assert.equal(b.json.deportista_id, "D1001");
});

test("ids: formato con ceros (CAT, I)", async () => {
  const c = await api("POST", "/api/categorias", { token: tokenA, body: { nombre: "Otra" } });
  assert.match(c.json.categoria_id, /^CAT\d{2,}$/);
});

test("raíz: GET / responde ok", async () => {
  const r = await api("GET", "/");
  assert.equal(r.json.ok, true);
});

// ================================================================ VENCIMIENTOS, EDITAR Y ELIMINAR
// Se usa un tercer entrenador (Carla) con datos propios para no depender de los conteos de A y B.
const sumarDias = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const HOY = hoyISO();
let tokenC, catC, depC1, depC2;

test("estados (unidad): pagado, vencido, próximo, pendiente y sin fecha", () => {
  const hoy = "2026-11-10";
  assert.equal(estadoPago(true, "2020-01-01", hoy), "pagado"); // pagado gana aunque esté vencido
  assert.equal(estadoPago(false, "2026-11-09", hoy), "vencido");
  assert.equal(estadoPago(false, "2026-11-10", hoy), "proximo"); // vence hoy
  assert.equal(estadoPago(false, "2026-11-13", hoy), "proximo"); // a 3 días
  assert.equal(estadoPago(false, "2026-11-14", hoy), "pendiente"); // a 4 días
  assert.equal(estadoPago(false, null, hoy), "pendiente");
  assert.equal(diasRestantes("2026-11-07", hoy), -3);
  assert.equal(diasRestantes(null, hoy), null);
});

test("fechas (unidad): solo fechas reales AAAA-MM-DD", () => {
  assert.equal(fechaValida("2026-02-28"), true);
  assert.equal(fechaValida("2026-02-31"), false);
  assert.equal(fechaValida("31/12/2026"), false);
  assert.equal(fechaValida("mañana"), false);
  assert.equal(fechaValida(20261231), false);
});

test("setup: entrenadora C con categoría y dos deportistas", async () => {
  await db.collection("entrenadores").insertOne({ entrenador_id: "E03", nombre: "Carla", apellido: "Gil", usuario: "carla", passwordHash: await bcrypt.hash("clave1234", 4) });
  tokenC = (await api("POST", "/api/auth/login", { body: { usuario: "carla", password: "clave1234" } })).json.token;
  catC = (await api("POST", "/api/categorias", { token: tokenC, body: { nombre: "Sub-17" } })).json.categoria_id;
  const a = await api("POST", "/api/deportistas", { token: tokenC, body: { nombre: "Andrea Pérez", identificacion: "1001" } });
  const b = await api("POST", "/api/deportistas", { token: tokenC, body: { nombre: "Bianca Ruiz", identificacion: 1002 } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.json.identificacion, "1002"); // número -> texto
  depC1 = a.json.deportista_id; depC2 = b.json.deportista_id;
});

// ---- Ítems: vencimiento, detalle, editar, eliminar
let itVencido, itProximo, itLejano, itSinFecha;

test("ítems: crear con fecha de vencimiento (y valores inválidos -> 400)", async () => {
  const mk = (nombre, fecha) => api("POST", `/api/categorias/${catC}/items`, { token: tokenC, body: { nombre, valor: 40000, fecha_vencimiento: fecha } });
  const v = await mk("Mensualidad pasada", sumarDias(HOY, -5));
  const p = await mk("Torneo regional", sumarDias(HOY, 2));
  const l = await mk("Uniforme nuevo", sumarDias(HOY, 30));
  const s = await api("POST", `/api/categorias/${catC}/items`, { token: tokenC, body: { nombre: "Rifa" } });
  assert.deepEqual([v.status, p.status, l.status, s.status], [201, 201, 201, 201]);
  assert.equal(v.json.fecha_vencimiento, sumarDias(HOY, -5));
  assert.equal(s.json.fecha_vencimiento, null);
  itVencido = v.json.item_id; itProximo = p.json.item_id; itLejano = l.json.item_id; itSinFecha = s.json.item_id;

  const ruta = `/api/categorias/${catC}/items`;
  assert.equal((await api("POST", ruta, { token: tokenC, body: { nombre: "x", fecha_vencimiento: "2026-02-31" } })).status, 400);
  assert.equal((await api("POST", ruta, { token: tokenC, body: { nombre: "x", fecha_vencimiento: "31/12/2026" } })).status, 400);
  assert.equal((await api("POST", ruta, { token: tokenC, body: { nombre: "x", valor: -5 } })).status, 400);
  assert.equal((await api("POST", ruta, { token: tokenC, body: { nombre: "x", valor: "mucho" } })).status, 400);
});

test("ítems: GET detalle -> 200 y 404 si no existe", async () => {
  const r = await api("GET", `/api/items/${itVencido}`, { token: tokenC });
  assert.equal(r.status, 200);
  assert.equal(r.json.nombre, "Mensualidad pasada");
  assert.equal((await api("GET", "/api/items/I99999", { token: tokenC })).status, 404);
});

test("ítems: PUT edita nombre, valor y fecha; valida y respeta propiedad", async () => {
  const ok = await api("PUT", `/api/items/${itSinFecha}`, { token: tokenC, body: { nombre: "Rifa pro-viaje", valor: 10000, fecha_vencimiento: sumarDias(HOY, 20) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.nombre, "Rifa pro-viaje");
  assert.equal(ok.json.valor, 10000);
  assert.equal((await api("GET", `/api/items/${itSinFecha}`, { token: tokenC })).json.fecha_vencimiento, sumarDias(HOY, 20));
  assert.equal((await api("PUT", `/api/items/${itSinFecha}`, { token: tokenC, body: {} })).status, 400);
  assert.equal((await api("PUT", `/api/items/${itSinFecha}`, { token: tokenC, body: { nombre: "x", fecha_vencimiento: "ayer" } })).status, 400);
  assert.equal((await api("PUT", `/api/items/${itSinFecha}`, { token: tokenB, body: { nombre: "hackeo" } })).status, 404);
  assert.equal((await api("PUT", "/api/items/I99999", { token: tokenC, body: { nombre: "x" } })).status, 404);
});

// ---- Regla de negocio: estados por vencimiento
test("vencimientos: cada ítem calcula su estado según la fecha", async () => {
  const estado = async (item) => (await api("GET", `/api/items/${item}/pagos`, { token: tokenC })).json.deportistas[0].estado;
  assert.equal(await estado(itVencido), "vencido");
  assert.equal(await estado(itProximo), "proximo");
  assert.equal(await estado(itLejano), "pendiente");
  const r = (await api("GET", `/api/items/${itVencido}/pagos`, { token: tokenC })).json;
  assert.equal(r.deportistas[0].dias_restantes, -5);
  assert.deepEqual(r.resumen, { pagado: 0, pendiente: 0, proximo: 0, vencido: 2 });
});

test("vencimientos: filtro ?estado= en un ítem; estado inválido -> 400", async () => {
  const v = await api("GET", `/api/items/${itVencido}/pagos?estado=vencido`, { token: tokenC });
  assert.equal(v.json.deportistas.length, 2);
  const p = await api("GET", `/api/items/${itVencido}/pagos?estado=pagado`, { token: tokenC });
  assert.equal(p.json.deportistas.length, 0);
  assert.equal((await api("GET", `/api/items/${itVencido}/pagos?estado=roto`, { token: tokenC })).status, 400);
  assert.equal((await api("GET", `/api/items/${itVencido}/pagos?estado=vencido&estado=pagado`, { token: tokenC })).status, 400);
});

test("vencimientos: al marcar pagado, deja de estar vencido (y vuelve si se desmarca)", async () => {
  const m = await api("PATCH", `/api/items/${itVencido}/pagos/${depC1}`, { token: tokenC, body: { pagado: true } });
  assert.equal(m.json.estado, "pagado");
  const v = await api("GET", `/api/items/${itVencido}/pagos?estado=vencido`, { token: tokenC });
  assert.deepEqual(v.json.deportistas.map((d) => d.deportista_id), [depC2]);
  const d = await api("PATCH", `/api/items/${itVencido}/pagos/${depC1}`, { token: tokenC, body: { pagado: false } });
  assert.equal(d.json.estado, "vencido");
});

test("GET /api/pagos: vista general con filtros estado y deportistaId, ordenada por vencimiento", async () => {
  const todos = await api("GET", "/api/pagos", { token: tokenC });
  assert.equal(todos.status, 200);
  assert.equal(todos.json.length, 8); // 4 ítems x 2 deportistas
  const fechas = todos.json.map((x) => x.fecha_vencimiento);
  assert.deepEqual(fechas, [...fechas].sort()); // ascendente
  const venc = await api("GET", "/api/pagos?estado=vencido", { token: tokenC });
  assert.equal(venc.json.length, 2);
  assert.ok(venc.json.every((x) => x.estado === "vencido" && x.item_nombre === "Mensualidad pasada" && x.categoria_nombre === "Sub-17"));
  const uno = await api("GET", `/api/pagos?deportistaId=${depC1}`, { token: tokenC });
  assert.equal(uno.json.length, 4);
  assert.equal((await api("GET", "/api/pagos?estado=xyz", { token: tokenC })).status, 400);
  assert.equal((await api("GET", "/api/pagos")).status, 401);
});

test("GET /api/pagos: aislamiento, B no ve nada de C", async () => {
  const r = await api("GET", "/api/pagos?estado=vencido", { token: tokenB });
  assert.equal(r.status, 200);
  assert.ok(!r.json.some((x) => x.categoria_id === catC));
});

// ---- Deportistas: detalle, editar, buscar, eliminar
test("deportistas: GET detalle -> 200, 404 si no existe o es de otro entrenador", async () => {
  const r = await api("GET", `/api/deportistas/${depC1}`, { token: tokenC });
  assert.equal(r.status, 200);
  assert.equal(r.json.nombre, "Andrea Pérez");
  assert.equal((await api("GET", "/api/deportistas/D99999", { token: tokenC })).status, 404);
  assert.equal((await api("GET", `/api/deportistas/${depC1}`, { token: tokenB })).status, 404);
});

test("deportistas: identificación repetida -> 409 (crear y editar)", async () => {
  assert.equal((await api("POST", "/api/deportistas", { token: tokenC, body: { nombre: "Clon", identificacion: "1001" } })).status, 409);
  assert.equal((await api("PUT", `/api/deportistas/${depC2}`, { token: tokenC, body: { nombre: "Bianca Ruiz", identificacion: "1001" } })).status, 409);
  // otro entrenador sí puede usar la misma identificación
  assert.equal((await api("POST", "/api/deportistas", { token: tokenB, body: { nombre: "Otra Andrea", identificacion: "1001" } })).status, 201);
  // identificación inválida
  assert.equal((await api("POST", "/api/deportistas", { token: tokenC, body: { nombre: "X", identificacion: { $ne: 1 } } })).status, 400);
});

test("deportistas: PUT edita; conservar su propia identificación no da 409", async () => {
  const r = await api("PUT", `/api/deportistas/${depC1}`, { token: tokenC, body: { nombre: "Andrea P. Gómez", identificacion: "1001" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.nombre, "Andrea P. Gómez");
  assert.equal((await api("PUT", `/api/deportistas/${depC1}`, { token: tokenC, body: {} })).status, 400);
  assert.equal((await api("PUT", `/api/deportistas/${depC1}`, { token: tokenB, body: { nombre: "hackeo" } })).status, 404);
  assert.equal((await api("GET", `/api/deportistas/${depC1}`, { token: tokenC })).json.nombre, "Andrea P. Gómez");
});

test("deportistas: ?buscar= filtra por nombre o identificación, sin importar tildes/mayúsculas", async () => {
  const por = async (q) => (await api("GET", `/api/deportistas?buscar=${encodeURIComponent(q)}`, { token: tokenC })).json.map((d) => d.deportista_id);
  assert.deepEqual(await por("gomez"), [depC1]);
  assert.deepEqual(await por("BIANCA"), [depC2]);
  assert.deepEqual(await por("1002"), [depC2]);
  assert.deepEqual(await por("zzz"), []);
  assert.equal((await por("")).length, 2);
  assert.equal((await api("GET", "/api/deportistas?buscar=a&buscar=b", { token: tokenC })).status, 400);
});

test("deportistas: DELETE desactiva -> 204; luego 404 y desaparece de listas y pagos", async () => {
  assert.equal((await api("DELETE", `/api/deportistas/${depC2}`, { token: tokenB })).status, 404); // no es suyo
  assert.equal((await api("DELETE", `/api/deportistas/${depC2}`, { token: tokenC })).status, 204);
  assert.equal((await api("GET", `/api/deportistas/${depC2}`, { token: tokenC })).status, 404);
  assert.equal((await api("DELETE", `/api/deportistas/${depC2}`, { token: tokenC })).status, 404);
  assert.deepEqual((await api("GET", "/api/deportistas", { token: tokenC })).json.map((d) => d.deportista_id), [depC1]);
  assert.equal((await api("GET", `/api/items/${itVencido}/pagos`, { token: tokenC })).json.deportistas.length, 1);
  assert.equal((await api("GET", "/api/pagos", { token: tokenC })).json.length, 4);
  // su identificación queda libre para reutilizarse
  assert.equal((await api("POST", "/api/deportistas", { token: tokenC, body: { nombre: "Nueva Bianca", identificacion: "1002" } })).status, 201);
});

// ---- Eliminar ítems y categorías
test("ítems: DELETE -> 409 si tiene pagos pagados; 204 si no; luego 404", async () => {
  await api("PATCH", `/api/items/${itLejano}/pagos/${depC1}`, { token: tokenC, body: { pagado: true } });
  const bloqueado = await api("DELETE", `/api/items/${itLejano}`, { token: tokenC });
  assert.equal(bloqueado.status, 409);
  assert.ok(bloqueado.json.error);
  assert.equal((await api("DELETE", `/api/items/${itProximo}`, { token: tokenB })).status, 404); // no es suyo
  assert.equal((await api("DELETE", `/api/items/${itProximo}`, { token: tokenC })).status, 204);
  assert.equal((await api("GET", `/api/items/${itProximo}`, { token: tokenC })).status, 404);
  assert.equal(await db.collection("pagos").countDocuments({ item_id: itProximo }), 0); // limpió sus pagos
  await api("PATCH", `/api/items/${itLejano}/pagos/${depC1}`, { token: tokenC, body: { pagado: false } });
  assert.equal((await api("DELETE", `/api/items/${itLejano}`, { token: tokenC })).status, 204);
});

test("categorías: GET detalle, PUT, y DELETE (409 con ítems, 204 vacía)", async () => {
  assert.equal((await api("GET", `/api/categorias/${catC}`, { token: tokenC })).json.nombre, "Sub-17");
  assert.equal((await api("GET", `/api/categorias/${catC}`, { token: tokenB })).status, 404);
  assert.equal((await api("PUT", `/api/categorias/${catC}`, { token: tokenC, body: { nombre: "Sub-17 Femenino" } })).json.nombre, "Sub-17 Femenino");
  assert.equal((await api("PUT", `/api/categorias/${catC}`, { token: tokenC, body: { nombre: " " } })).status, 400);
  assert.equal((await api("PUT", `/api/categorias/${catC}`, { token: tokenB, body: { nombre: "hackeo" } })).status, 404);
  assert.equal((await api("DELETE", `/api/categorias/${catC}`, { token: tokenC })).status, 409); // aún tiene ítems
  const vacia = await api("POST", "/api/categorias", { token: tokenC, body: { nombre: "Temporal" } });
  assert.equal((await api("DELETE", `/api/categorias/${vacia.json.categoria_id}`, { token: tokenB })).status, 404);
  assert.equal((await api("DELETE", `/api/categorias/${vacia.json.categoria_id}`, { token: tokenC })).status, 204);
  assert.equal((await api("GET", `/api/categorias/${vacia.json.categoria_id}`, { token: tokenC })).status, 404);
});
