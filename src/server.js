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
app.use(cors());
app.use(express.json());
app.get("/", (req, res) => res.json({ ok: true, api: "Club Cometa" }));
app.use("/api", crearRutas(db));

// Manejo de errores: cualquier fallo inesperado responde 500 en JSON
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
});

const puerto = process.env.PORT || 3000;
app.listen(puerto, () => console.log(`API escuchando en http://localhost:${puerto}`));
