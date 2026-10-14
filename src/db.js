import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");

export async function conectar() {
  await client.connect();
  return client.db(process.env.DB_NAME || "cometa");
}
