import "dotenv/config";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

const [usuario, nueva] = process.argv.slice(2);
if (!usuario || !nueva || nueva.length < 4) {
  console.error("Uso: node scripts/cambiar-password.js <usuario> <nueva-contraseña (mínimo 4 caracteres)>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
try {
  await client.connect();
  const db = client.db(process.env.DB_NAME || "cometa");
  const col = db.collection("entrenadores");
  const entrenador = await col.findOne({ usuario });
  if (!entrenador) {
    const existentes = (await col.find({}, { projection: { usuario: 1, _id: 0 } }).toArray()).map((e) => e.usuario);
    console.error(`No existe el usuario "${usuario}". Usuarios encontrados: ${existentes.join(", ") || "(ninguno)"}`);
    process.exit(1);
  }
  await col.updateOne({ _id: entrenador._id }, { $set: { passwordHash: await bcrypt.hash(nueva, 10) } });
  console.log(`Listo: la contraseña de "${usuario}" fue cambiada en la base "${db.databaseName}".`);
} finally {
  await client.close();
}