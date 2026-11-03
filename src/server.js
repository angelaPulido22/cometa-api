import "dotenv/config";
import express from "express";
import cors from "cors";
import { conectar } from "./db.js";
import { crearRutas } from "./rutas.js";

if (!process.env.JWT_SECRET) {
  console.error("Falta JWT_SECRET en el archivo .env");
  process.exit(1);
}

const db = await conectar();
console.log("Conectado a MongoDB:", db.databaseName);

const app = express();
// Si la API corre detrás de un proxy (Nginx, Render, Railway...), pon TRUST_PROXY=1 en las variables de entorno
// para que req.ip sea la IP real del cliente (si no, el bloqueo de login cuenta mal).
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// Express 5 deja req.body en undefined cuando la petición no trae JSON.
// Lo normalizamos a {} para que las rutas validen campos en vez de reventar.
app.use((req, res, next) => {
  if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) req.body = {};
  next();
});

app.get("/", (req, res) => res.json({ ok: true, api: "Club Cometa" }));
app.use("/api", crearRutas(db));

// Manejo de errores: JSON mal formado -> 400; cualquier otro fallo inesperado -> 500 en JSON
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "El cuerpo de la petición no es un JSON válido" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "La petición es demasiado grande" });
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
});

const puerto = process.env.PORT || 3000;
app.listen(puerto, () => console.log(`API escuchando en http://localhost:${puerto}`));
