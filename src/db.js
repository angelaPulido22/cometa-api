import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");

export async function conectar() {
  await client.connect();
  const db = client.db(process.env.DB_NAME || "cometa");
  await asegurarIndices(db);
  return db;
}

// Índices únicos: última línea de defensa para que nunca existan dos registros con el mismo id.
// Si la base ya trae duplicados, avisa por consola en vez de impedir el arranque.
async function asegurarIndices(db) {
  const unicos = [
    ["entrenadores", { entrenador_id: 1 }],
    ["entrenadores", { usuario: 1 }],
    ["categorias", { categoria_id: 1 }],
    ["items", { item_id: 1 }],
    ["deportistas", { deportista_id: 1 }],
    ["pagos", { item_id: 1, deportista_id: 1 }],
  ];
  for (const [coleccion, campos] of unicos) {
    try {
      await db.collection(coleccion).createIndex(campos, { unique: true });
    } catch (e) {
      console.warn(`No se pudo crear el índice único en ${coleccion} ${JSON.stringify(campos)}: ${e.message}`);
    }
  }
}
