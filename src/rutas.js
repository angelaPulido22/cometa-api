import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Genera el siguiente id legible: D010, I006, CAT04...
async function siguienteId(col, campo, prefijo, ancho) {
  const ultimo = await col.find().sort({ [campo]: -1 }).limit(1).next();
  const n = ultimo ? parseInt(ultimo[campo].slice(prefijo.length), 10) + 1 : 1;
  return prefijo + String(n).padStart(ancho, "0");
}

const textoValido = (t) => typeof t === "string" && t.trim().length > 0;

export function crearRutas(db) {
  const r = Router();
  const entrenadores = db.collection("entrenadores");
  const categorias = db.collection("categorias");
  const items = db.collection("items");
  const deportistas = db.collection("deportistas");
  const pagos = db.collection("pagos");

  // ---------- Login (público) ----------
  r.post("/auth/login", async (req, res) => {
    const { usuario, password } = req.body;
    const e = await entrenadores.findOne({ usuario });
    if (!e || !(await bcrypt.compare(password || "", e.passwordHash))) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }
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
    const repetido = await entrenadores.findOne({ usuario, entrenador_id: { $ne: req.entrenadorId } });
    if (repetido) return res.status(409).json({ error: "Ese usuario ya existe" });
    await entrenadores.updateOne({ entrenador_id: req.entrenadorId }, { $set: { nombre, apellido, usuario } });
    res.json({ ok: true });
  });

  r.put("/perfil/password", async (req, res) => {
    const { actual, nueva } = req.body;
    const e = await entrenadores.findOne({ entrenador_id: req.entrenadorId });
    if (!(await bcrypt.compare(actual || "", e.passwordHash))) return res.status(401).json({ error: "La contraseña actual no es correcta" });
    if (!textoValido(nueva) || nueva.length < 4) return res.status(400).json({ error: "La nueva contraseña debe tener al menos 4 caracteres" });
    await entrenadores.updateOne({ entrenador_id: req.entrenadorId }, { $set: { passwordHash: await bcrypt.hash(nueva, 10) } });
    res.json({ ok: true });
  });

  // ---------- Categorías ----------
  r.get("/categorias", async (req, res) => {
    res.json(await categorias.find({ entrenador_id: req.entrenadorId }, { projection: { _id: 0 } }).sort({ categoria_id: 1 }).toArray());
  });

  r.post("/categorias", async (req, res) => {
    if (!textoValido(req.body.nombre)) return res.status(400).json({ error: "El nombre es obligatorio" });
    const nueva = {
      categoria_id: await siguienteId(categorias, "categoria_id", "CAT", 2),
      entrenador_id: req.entrenadorId,
      nombre: req.body.nombre.trim(),
      subtitulo: "Pagos",
      directa: false,
    };
    await categorias.insertOne(nueva);
    delete nueva._id;
    res.status(201).json(nueva);
  });

  // ---------- Ítems (temporadas, torneos...) ----------
  r.get("/categorias/:categoriaId/items", async (req, res) => {
    res.json(await items.find({ categoria_id: req.params.categoriaId }, { projection: { _id: 0 } }).sort({ item_id: 1 }).toArray());
  });

  r.post("/categorias/:categoriaId/items", async (req, res) => {
    const categoria = await categorias.findOne({ categoria_id: req.params.categoriaId, entrenador_id: req.entrenadorId });
    if (!categoria) return res.status(404).json({ error: "Categoría no encontrada" });
    if (!textoValido(req.body.nombre)) return res.status(400).json({ error: "El nombre es obligatorio" });
    const nuevo = {
      item_id: await siguienteId(items, "item_id", "I", 3),
      categoria_id: categoria.categoria_id,
      nombre: req.body.nombre.trim(),
      valor: typeof req.body.valor === "number" ? req.body.valor : null,
    };
    await items.insertOne(nuevo);
    // Un registro de pago pendiente por cada deportista activo
    const activos = await deportistas.find({ entrenador_id: req.entrenadorId, activo: true }).toArray();
    if (activos.length) {
      await pagos.insertMany(activos.map((d) => ({ item_id: nuevo.item_id, deportista_id: d.deportista_id, pagado: false, fecha_pago: null })));
    }
    delete nuevo._id;
    res.status(201).json(nuevo);
  });

  // ---------- Deportistas ----------
  r.get("/deportistas", async (req, res) => {
    res.json(await deportistas.find({ entrenador_id: req.entrenadorId, activo: true }, { projection: { _id: 0 } }).sort({ deportista_id: 1 }).toArray());
  });

  r.post("/deportistas", async (req, res) => {
    if (!textoValido(req.body.nombre)) return res.status(400).json({ error: "El nombre es obligatorio" });
    const nuevo = {
      deportista_id: await siguienteId(deportistas, "deportista_id", "D", 3),
      entrenador_id: req.entrenadorId,
      nombre: req.body.nombre.trim(),
      activo: true,
    };
    await deportistas.insertOne(nuevo);
    // Un registro de pago pendiente por cada ítem existente
    const todos = await items.find().toArray();
    if (todos.length) {
      await pagos.insertMany(todos.map((i) => ({ item_id: i.item_id, deportista_id: nuevo.deportista_id, pagado: false, fecha_pago: null })));
    }
    delete nuevo._id;
    res.status(201).json(nuevo);
  });

  // ---------- Pagos ----------
  // Lista de deportistas con su estado de pago en un ítem (la pantalla de checkboxes)
  r.get("/items/:itemId/pagos", async (req, res) => {
    const item = await items.findOne({ item_id: req.params.itemId }, { projection: { _id: 0 } });
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    const lista = await pagos.aggregate([
      { $match: { item_id: req.params.itemId } },
      { $lookup: { from: "deportistas", localField: "deportista_id", foreignField: "deportista_id", as: "d" } },
      { $unwind: "$d" },
      { $match: { "d.activo": true } },
      { $project: { _id: 0, deportista_id: 1, nombre: "$d.nombre", pagado: 1, fecha_pago: 1 } },
      { $sort: { deportista_id: 1 } },
    ]).toArray();
    res.json({ item, deportistas: lista });
  });

  // Marcar o desmarcar el checkbox de pago
  r.patch("/items/:itemId/pagos/:deportistaId", async (req, res) => {
    if (typeof req.body.pagado !== "boolean") return res.status(400).json({ error: "'pagado' debe ser true o false" });
    const pagado = req.body.pagado;
    const resultado = await pagos.updateOne(
      { item_id: req.params.itemId, deportista_id: req.params.deportistaId },
      { $set: { pagado, fecha_pago: pagado ? new Date().toISOString().slice(0, 10) : null } }
    );
    if (!resultado.matchedCount) return res.status(404).json({ error: "Pago no encontrado" });
    res.json({ ok: true, pagado });
  });

  return r;
}
