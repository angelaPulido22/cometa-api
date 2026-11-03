// Repara los documentos de la colección "entrenadores" que se cargaron mal:
//   1. Campos anidados dentro de una clave "0"  ->  se suben al nivel principal.
//   2. passwordHash en texto plano              ->  se convierte en hash bcrypt.
// Es seguro ejecutarlo varias veces: no toca lo que ya está correcto.
// Uso:  npm run reparar
import "dotenv/config";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

const esHashBcrypt = (t) => typeof t === "string" && /^\$2[aby]\$\d{2}\$.{53}$/.test(t);

const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
try {
  await client.connect();
  const db = client.db(process.env.DB_NAME || "cometa");
  const col = db.collection("entrenadores");
  console.log(`Base de datos: ${db.databaseName}`);

  let reparados = 0;
  for (const doc of await col.find().toArray()) {
    const { _id, "0": anidado, ...resto } = doc;
    const nuevo = { ...resto, ...(anidado && typeof anidado === "object" ? anidado : {}) };
    const cambios = [];
    if (anidado) cambios.push("campos subidos al nivel principal");
    if (!esHashBcrypt(nuevo.passwordHash)) {
      if (typeof nuevo.passwordHash !== "string" || !nuevo.passwordHash) {
        console.warn(`  ! ${nuevo.usuario ?? _id}: no tiene contraseña; asígnala con otro método.`);
      } else {
        nuevo.passwordHash = await bcrypt.hash(nuevo.passwordHash, 10);
        cambios.push("contraseña convertida a hash bcrypt");
      }
    }
    const faltan = ["entrenador_id", "nombre", "apellido", "usuario", "passwordHash"].filter((c) => !nuevo[c]);
    if (faltan.length) console.warn(`  ! ${nuevo.usuario ?? _id}: faltan los campos ${faltan.join(", ")}`);
    if (cambios.length) {
      await col.replaceOne({ _id }, nuevo);
      reparados++;
      console.log(`  ✔ ${nuevo.usuario}: ${cambios.join(" y ")}`);
    }
  }
  console.log(reparados ? `Listo: ${reparados} entrenador(es) reparado(s).` : "Nada que reparar: los entrenadores ya están bien.");
} finally {
  await client.close();
}
