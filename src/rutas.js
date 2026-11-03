import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { estaBloqueado, registrarFallo, registrarExito } from "./limitador.js";
import { ESTADOS, estadoPago, diasRestantes, fechaValida, hoyISO } from "./estados.js";

// Genera el siguiente id legible: D010, I006, CAT04...
// Usa un contador atómico (colección "counters"), así dos peticiones simultáneas
// nunca reciben el mismo número y D999 -> D1000 no se desordena.
async function siguienteId(db, col, campo, prefijo, ancho) {
  const contadores = db.collection("counters");
  if (!(await contadores.findOne({ _id: prefijo }))) {
    // Primera vez: partir del mayor número que ya exista (comparado como número, no como texto)
    let max = 0;
    for await (const d of col.find({}, { projection: { [campo]: 1 } })) {
      const n = parseInt(String(d[campo]).slice(prefijo.length), 10);
      if (n > max) max = n;
    }
    try {
      await contadores.insertOne({ _id: prefijo, seq: max });
    } catch (e) {
      if (e.code !== 11000) throw e; // otra petición lo creó justo antes: no pasa nada
    }
  }
  const c = await contadores.findOneAndUpdate({ _id: prefijo }, { $inc: { seq: 1 } }, { returnDocument: "after" });
  return prefijo + String(c.seq).padStart(ancho, "0");
}

// Inserta un documento con id nuevo. Si el índice único rechaza el id (contador desfasado porque
// alguien cargó datos a mano, o un choque improbable), reintenta con el siguiente número.
// `construir(id)` debe devolver un objeto NUEVO en cada llamada (el driver le añade _id al insertarlo).
async function insertarConId(db, col, campo, prefijo, ancho, construir) {
  for (let intento = 1; ; intento++) {
    const doc = construir(await siguienteId(db, col, campo, prefijo, ancho));
    try {
      await col.insertOne(doc);
      return doc;
    } catch (e) {
      if (e.code !== 11000 || intento >= 25) throw e;
    }
  }
}

// Ordena por la parte numérica del id (D2 antes que D10)
const porNumero = (campo) => (a, b) => (parseInt(a[campo].replace(/\D/g, ""), 10) || 0) - (parseInt(b[campo].replace(/\D/g, ""), 10) || 0);

const textoValido = (t) => typeof t === "string" && t.trim().length > 0;

// Quita tildes y pasa a minúsculas para que "perez" encuentre "Pérez"
const normalizar = (t) => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Valida y limpia el cuerpo de un ítem (crear y editar usan las mismas reglas)
function leerItem(body) {
  if (!textoValido(body.nombre)) return { error: "El nombre es obligatorio" };
  let valor = null;
  if (body.valor !== undefined && body.valor !== null) {
    if (typeof body.valor !== "number" || !Number.isFinite(body.valor) || body.valor < 0) return { error: "El valor debe ser un número mayor o igual a 0" };
    valor = body.valor;
  }
  let fecha_vencimiento = null;
  if (body.fecha_vencimiento !== undefined && body.fecha_vencimiento !== null) {
    if (!fechaValida(body.fecha_vencimiento)) return { error: "La fecha de vencimiento debe ser una fecha real con formato AAAA-MM-DD" };
    fecha_vencimiento = body.fecha_vencimiento;
  }
  return { datos: { nombre: body.nombre.trim(), valor, fecha_vencimiento } };
}

// Valida y limpia el cuerpo de un deportista (identificación opcional)
function leerDeportista(body) {
  if (!textoValido(body.nombre)) return { error: "El nombre es obligatorio" };
  let identificacion = null;
  if (body.identificacion !== undefined && body.identificacion !== null) {
    if (typeof body.identificacion !== "string" && typeof body.identificacion !== "number") return { error: "La identificación debe ser texto o número" };
    identificacion = String(body.identificacion).trim() || null;
    if (identificacion && identificacion.length > 30) return { error: "La identificación es demasiado larga (máximo 30 caracteres)" };
  }
  return { datos: { nombre: body.nombre.trim(), identificacion } };
}

// Los ítems creados antes de existir el vencimiento no traen el campo: se devuelve null
const conVencimiento = (i) => ({ fecha_vencimiento: null, ...i });

// Hash de relleno: se compara aunque el usuario no exista, para que responder
// "usuario inexistente" no sea notablemente más rápido que "contraseña incorrecta".
const HASH_FALSO = bcrypt.hashSync("relleno-sin-uso", 10);

export function crearRutas(db) {
  const r = Router();
  const entrenadores = db.collection("entrenadores");
  const categorias = db.collection("categorias");
  const items = db.collection("items");
  const deportistas = db.collection("deportistas");
  const pagos = db.collection("pagos");

  // ---------- Helpers de propiedad: todo recurso debe pertenecer al entrenador del token ----------
  const categoriaPropia = (categoriaId, entrenadorId) =>
    typeof categoriaId === "string" ? categorias.findOne({ categoria_id: categoriaId, entrenador_id: entrenadorId }) : null;

  // Un ítem es del entrenador si su categoría lo es
  async function itemPropio(itemId, entrenadorId) {
    if (typeof itemId !== "string") return null;
    const item = await items.findOne({ item_id: itemId }, { projection: { _id: 0 } });
    if (!item) return null;
    return (await categoriaPropia(item.categoria_id, entrenadorId)) ? item : null;
  }

  // ---------- Login (público) ----------
  r.post("/auth/login", async (req, res) => {
    const { usuario, password } = req.body;
    // Deben ser texto: evita errores internos y la inyección tipo { "usuario": { "$ne": null } }
    if (!textoValido(usuario) || !textoValido(password)) {
      return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
    }
    const nombreUsuario = usuario.trim();
    if (estaBloqueado(req.ip, nombreUsuario)) {
      return res.status(429).json({ error: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo" });
    }
    const e = await entrenadores.findOne({ usuario: nombreUsuario });
    const clave_ok = await bcrypt.compare(password, e ? e.passwordHash : HASH_FALSO);
    if (!e || !clave_ok) {
      registrarFallo(req.ip, nombreUsuario);
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }
    registrarExito(req.ip, nombreUsuario);
    const token = jwt.sign({ entrenador_id: e.entrenador_id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, nombre: e.nombre });
  });

  // ---------- Todo lo de abajo exige token ----------
  r.use((req, res, next) => {
    const cabecera = req.headers.authorization || "";
    try {
      const datos = jwt.verify(cabecera.replace("Bearer ", ""), process.env.JWT_SECRET);
      req.entrenadorId = datos.entrenador_id;
      next();
    } catch {
      res.status(401).json({ error: "Sesión no válida, inicia sesión de nuevo" });
    }
  });

  // ---------- Perfil ----------
  r.get("/perfil", async (req, res) => {
    const e = await entrenadores.findOne({ entrenador_id: req.entrenadorId }, { projection: { _id: 0, passwordHash: 0 } });
    res.json(e);
  });

  r.put("/perfil", async (req, res) => {
    const { nombre, apellido, usuario } = req.body;
    if (![nombre, apellido, usuario].every(textoValido)) return res.status(400).json({ error: "Nombre, apellido y usuario son obligatorios" });
    const datos = { nombre: nombre.trim(), apellido: apellido.trim(), usuario: usuario.trim() };
    const repetido = await entrenadores.findOne({ usuario: datos.usuario, entrenador_id: { $ne: req.entrenadorId } });
    if (repetido) return res.status(409).json({ error: "Ese usuario ya existe" });
    await entrenadores.updateOne({ entrenador_id: req.entrenadorId }, { $set: datos });
    res.json({ ok: true });
  });

  r.put("/perfil/password", async (req, res) => {
    const { actual, nueva } = req.body;
    if (!textoValido(actual) || !textoValido(nueva)) return res.status(400).json({ error: "Debes indicar la contraseña actual y la nueva" });
    const e = await entrenadores.findOne({ entrenador_id: req.entrenadorId });
    if (!(await bcrypt.compare(actual, e.passwordHash))) return res.status(401).json({ error: "La contraseña actual no es correcta" });
    if (nueva.length < 4) return res.status(400).json({ error: "La nueva contraseña debe tener al menos 4 caracteres" });
    await entrenadores.updateOne({ entrenador_id: req.entrenadorId }, { $set: { passwordHash: await bcrypt.hash(nueva, 10) } });
    res.json({ ok: true });
  });

  // ---------- Categorías ----------
  r.get("/categorias", async (req, res) => {
    const lista = await categorias.find({ entrenador_id: req.entrenadorId }, { projection: { _id: 0 } }).toArray();
    res.json(lista.sort(porNumero("categoria_id")));
  });

  r.get("/categorias/:categoriaId", async (req, res) => {
    const c = await categoriaPropia(req.params.categoriaId, req.entrenadorId);
    if (!c) return res.status(404).json({ error: "Categoría no encontrada" });
    delete c._id;
    res.json(c);
  });

  r.post("/categorias", async (req, res) => {
    if (!textoValido(req.body.nombre)) return res.status(400).json({ error: "El nombre es obligatorio" });
    const nueva = await insertarConId(db, categorias, "categoria_id", "CAT", 2, (id) => ({
      categoria_id: id,
      entrenador_id: req.entrenadorId,
      nombre: req.body.nombre.trim(),
      subtitulo: "Pagos",
      directa: false,
    }));
    delete nueva._id;
    res.status(201).json(nueva);
  });

  r.put("/categorias/:categoriaId", async (req, res) => {
    const c = await categoriaPropia(req.params.categoriaId, req.entrenadorId);
    if (!c) return res.status(404).json({ error: "Categoría no encontrada" });
    if (!textoValido(req.body.nombre)) return res.status(400).json({ error: "El nombre es obligatorio" });
    await categorias.updateOne({ categoria_id: c.categoria_id }, { $set: { nombre: req.body.nombre.trim() } });
    const actualizada = await categorias.findOne({ categoria_id: c.categoria_id }, { projection: { _id: 0 } });
    res.json(actualizada);
  });

  // Una categoría con ítems no se borra: primero hay que eliminar sus ítems (evita perder pagos sin querer)
  r.delete("/categorias/:categoriaId", async (req, res) => {
    const c = await categoriaPropia(req.params.categoriaId, req.entrenadorId);
    if (!c) return res.status(404).json({ error: "Categoría no encontrada" });
    if (await items.findOne({ categoria_id: c.categoria_id })) {
      return res.status(409).json({ error: "No se puede eliminar una categoría que tiene ítems. Elimina primero sus ítems" });
    }
    await categorias.deleteOne({ categoria_id: c.categoria_id });
    res.status(204).end();
  });

  // ---------- Ítems (mensualidad, torneo, uniforme...) ----------
  r.get("/categorias/:categoriaId/items", async (req, res) => {
    if (!(await categoriaPropia(req.params.categoriaId, req.entrenadorId))) return res.status(404).json({ error: "Categoría no encontrada" });
    const lista = await items.find({ categoria_id: req.params.categoriaId }, { projection: { _id: 0 } }).toArray();
    res.json(lista.sort(porNumero("item_id")).map(conVencimiento));
  });

  r.post("/categorias/:categoriaId/items", async (req, res) => {
    const categoria = await categoriaPropia(req.params.categoriaId, req.entrenadorId);
    if (!categoria) return res.status(404).json({ error: "Categoría no encontrada" });
    const { datos, error } = leerItem(req.body);
    if (error) return res.status(400).json({ error });
    const nuevo = await insertarConId(db, items, "item_id", "I", 3, (id) => ({
      item_id: id,
      categoria_id: categoria.categoria_id,
      ...datos,
    }));
    // Un registro de pago pendiente por cada deportista activo de ESTE entrenador
    const activos = await deportistas.find({ entrenador_id: req.entrenadorId, activo: true }).toArray();
    if (activos.length) {
      await pagos.insertMany(activos.map((d) => ({ item_id: nuevo.item_id, deportista_id: d.deportista_id, pagado: false, fecha_pago: null })));
    }
    delete nuevo._id;
    res.status(201).json(nuevo);
  });

  r.get("/items/:itemId", async (req, res) => {
    const item = await itemPropio(req.params.itemId, req.entrenadorId);
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    res.json(conVencimiento(item));
  });

  r.put("/items/:itemId", async (req, res) => {
    const item = await itemPropio(req.params.itemId, req.entrenadorId);
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    const { datos, error } = leerItem(req.body);
    if (error) return res.status(400).json({ error });
    await items.updateOne({ item_id: item.item_id }, { $set: datos });
    res.json(conVencimiento({ ...item, ...datos }));
  });

  // Un ítem con pagos ya registrados como pagados no se borra (se perdería el historial de dinero recibido)
  r.delete("/items/:itemId", async (req, res) => {
    const item = await itemPropio(req.params.itemId, req.entrenadorId);
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    if (await pagos.findOne({ item_id: item.item_id, pagado: true })) {
      return res.status(409).json({ error: "No se puede eliminar: ya hay pagos registrados como pagados en este ítem" });
    }
    await pagos.deleteMany({ item_id: item.item_id });
    await items.deleteOne({ item_id: item.item_id });
    res.status(204).end();
  });

  // ---------- Deportistas ----------
  const deportistaActivo = (id, entrenadorId) =>
    typeof id === "string" ? deportistas.findOne({ deportista_id: id, entrenador_id: entrenadorId, activo: true }, { projection: { _id: 0 } }) : null;

  const identificacionRepetida = (identificacion, entrenadorId, excluirId) =>
    identificacion ? deportistas.findOne({ entrenador_id: entrenadorId, activo: true, identificacion, ...(excluirId ? { deportista_id: { $ne: excluirId } } : {}) }) : null;

  // ?buscar=texto filtra por nombre o identificación (sin importar mayúsculas ni tildes)
  r.get("/deportistas", async (req, res) => {
    const { buscar } = req.query;
    if (buscar !== undefined && typeof buscar !== "string") return res.status(400).json({ error: "'buscar' debe ser un texto" });
    let lista = await deportistas.find({ entrenador_id: req.entrenadorId, activo: true }, { projection: { _id: 0 } }).toArray();
    const termino = normalizar(buscar).trim();
    if (termino) lista = lista.filter((d) => normalizar(d.nombre).includes(termino) || normalizar(d.identificacion).includes(termino));
    res.json(lista.sort(porNumero("deportista_id")));
  });

  r.get("/deportistas/:deportistaId", async (req, res) => {
    const d = await deportistaActivo(req.params.deportistaId, req.entrenadorId);
    if (!d) return res.status(404).json({ error: "Deportista no encontrado" });
    res.json(d);
  });

  r.post("/deportistas", async (req, res) => {
    const { datos, error } = leerDeportista(req.body);
    if (error) return res.status(400).json({ error });
    if (await identificacionRepetida(datos.identificacion, req.entrenadorId)) {
      return res.status(409).json({ error: "Ya existe un deportista con esa identificación" });
    }
    const nuevo = await insertarConId(db, deportistas, "deportista_id", "D", 3, (id) => ({
      deportista_id: id,
      entrenador_id: req.entrenadorId,
      ...datos,
      activo: true,
    }));
    // Un registro de pago pendiente por cada ítem existente, pero sólo de las categorías de ESTE entrenador
    const susCategorias = (await categorias.find({ entrenador_id: req.entrenadorId }).toArray()).map((c) => c.categoria_id);
    const susItems = susCategorias.length ? await items.find({ categoria_id: { $in: susCategorias } }).toArray() : [];
    if (susItems.length) {
      await pagos.insertMany(susItems.map((i) => ({ item_id: i.item_id, deportista_id: nuevo.deportista_id, pagado: false, fecha_pago: null })));
    }
    delete nuevo._id;
    res.status(201).json(nuevo);
  });

  r.put("/deportistas/:deportistaId", async (req, res) => {
    const d = await deportistaActivo(req.params.deportistaId, req.entrenadorId);
    if (!d) return res.status(404).json({ error: "Deportista no encontrado" });
    const { datos, error } = leerDeportista(req.body);
    if (error) return res.status(400).json({ error });
    if (await identificacionRepetida(datos.identificacion, req.entrenadorId, d.deportista_id)) {
      return res.status(409).json({ error: "Ya existe otro deportista con esa identificación" });
    }
    await deportistas.updateOne({ deportista_id: d.deportista_id }, { $set: datos });
    res.json({ ...d, ...datos });
  });

  // Se desactiva (no se borra) para conservar el historial de pagos
  r.delete("/deportistas/:deportistaId", async (req, res) => {
    const d = await deportistaActivo(req.params.deportistaId, req.entrenadorId);
    if (!d) return res.status(404).json({ error: "Deportista no encontrado" });
    await deportistas.updateOne({ deportista_id: d.deportista_id }, { $set: { activo: false } });
    res.status(204).end();
  });

  // ---------- Pagos ----------
  // Valida ?estado= (pagado | pendiente | proximo | vencido). Devuelve el texto de error o null.
  const errorEstado = (estado) => (estado === undefined || ESTADOS.includes(estado) ? null : `'estado' debe ser uno de: ${ESTADOS.join(", ")}`);

  // Lista de deportistas con su estado de pago en un ítem (la pantalla de checkboxes).
  // El estado (pagado/pendiente/proximo/vencido) se calcula aquí según la fecha de vencimiento del ítem.
  // Filtro opcional: ?estado=vencido
  r.get("/items/:itemId/pagos", async (req, res) => {
    const msg = errorEstado(req.query.estado);
    if (msg) return res.status(400).json({ error: msg });
    const item = await itemPropio(req.params.itemId, req.entrenadorId);
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    const registros = await pagos.find({ item_id: item.item_id }).toArray();
    const ids = registros.map((p) => p.deportista_id);
    const activos = ids.length ? await deportistas.find({ deportista_id: { $in: ids }, entrenador_id: req.entrenadorId, activo: true }).toArray() : [];
    const nombres = new Map(activos.map((d) => [d.deportista_id, d.nombre]));
    const hoy = hoyISO();
    const venc = item.fecha_vencimiento ?? null;
    const todos = registros
      .filter((p) => nombres.has(p.deportista_id))
      .map((p) => ({
        deportista_id: p.deportista_id,
        nombre: nombres.get(p.deportista_id),
        pagado: p.pagado,
        fecha_pago: p.fecha_pago,
        estado: estadoPago(p.pagado, venc, hoy),
        dias_restantes: p.pagado ? null : diasRestantes(venc, hoy),
      }))
      .sort(porNumero("deportista_id"));
    const resumen = Object.fromEntries(ESTADOS.map((e) => [e, todos.filter((x) => x.estado === e).length]));
    const lista = req.query.estado ? todos.filter((x) => x.estado === req.query.estado) : todos;
    res.json({ item: conVencimiento(item), resumen, deportistas: lista });
  });

  // Vista general de TODOS los pagos del entrenador (para "¿quién me debe?").
  // Filtros opcionales: ?estado=vencido  y  ?deportistaId=D001. Ordenados por fecha de vencimiento.
  r.get("/pagos", async (req, res) => {
    const { estado, deportistaId } = req.query;
    const msg = errorEstado(estado);
    if (msg) return res.status(400).json({ error: msg });
    if (deportistaId !== undefined && typeof deportistaId !== "string") return res.status(400).json({ error: "'deportistaId' debe ser un texto" });

    const susCategorias = await categorias.find({ entrenador_id: req.entrenadorId }).toArray();
    const catPorId = new Map(susCategorias.map((c) => [c.categoria_id, c]));
    const susItems = catPorId.size ? await items.find({ categoria_id: { $in: [...catPorId.keys()] } }).toArray() : [];
    const itemPorId = new Map(susItems.map((i) => [i.item_id, i]));
    const activos = await deportistas.find({ entrenador_id: req.entrenadorId, activo: true }).toArray();
    const depPorId = new Map(activos.map((d) => [d.deportista_id, d]));
    const registros = itemPorId.size ? await pagos.find({ item_id: { $in: [...itemPorId.keys()] } }).toArray() : [];

    const hoy = hoyISO();
    let lista = registros
      .filter((p) => depPorId.has(p.deportista_id) && (!deportistaId || p.deportista_id === deportistaId))
      .map((p) => {
        const item = itemPorId.get(p.item_id);
        const venc = item.fecha_vencimiento ?? null;
        return {
          item_id: item.item_id,
          item_nombre: item.nombre,
          categoria_id: item.categoria_id,
          categoria_nombre: catPorId.get(item.categoria_id).nombre,
          valor: item.valor ?? null,
          fecha_vencimiento: venc,
          deportista_id: p.deportista_id,
          deportista_nombre: depPorId.get(p.deportista_id).nombre,
          pagado: p.pagado,
          fecha_pago: p.fecha_pago,
          estado: estadoPago(p.pagado, venc, hoy),
          dias_restantes: p.pagado ? null : diasRestantes(venc, hoy),
        };
      });
    if (estado) lista = lista.filter((x) => x.estado === estado);
    // Primero los que vencen antes; los que no tienen fecha, al final
    lista.sort((a, b) => (a.fecha_vencimiento ?? "9999-12-31").localeCompare(b.fecha_vencimiento ?? "9999-12-31") || porNumero("deportista_id")(a, b));
    res.json(lista);
  });

  // Marcar o desmarcar el checkbox de pago
  r.patch("/items/:itemId/pagos/:deportistaId", async (req, res) => {
    if (typeof req.body.pagado !== "boolean") return res.status(400).json({ error: "'pagado' debe ser true o false" });
    const item = await itemPropio(req.params.itemId, req.entrenadorId);
    const deportista = typeof req.params.deportistaId === "string" && (await deportistas.findOne({ deportista_id: req.params.deportistaId, entrenador_id: req.entrenadorId }));
    if (!item || !deportista) return res.status(404).json({ error: "Pago no encontrado" });
    const pagado = req.body.pagado;
    const hoy = hoyISO();
    const resultado = await pagos.updateOne(
      { item_id: item.item_id, deportista_id: deportista.deportista_id },
      { $set: { pagado, fecha_pago: pagado ? hoy : null } }
    );
    if (!resultado.matchedCount) return res.status(404).json({ error: "Pago no encontrado" });
    res.json({ ok: true, pagado, estado: estadoPago(pagado, item.fecha_vencimiento ?? null, hoy) });
  });

  return r;
}
