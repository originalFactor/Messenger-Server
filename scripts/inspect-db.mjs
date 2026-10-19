// One-shot read-only inspection of the Messenger MongoDB to identify smoke data.
// Does NOT mutate anything. Connects directly to the driver (no getDb side effects).
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME ?? "messenger";
if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const client = new MongoClient(uri, { maxPoolSize: 3, connectTimeoutMS: 5_000, serverSelectionTimeoutMS: 5_000 });

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const collections = await db.listCollections().toArray();
  console.log(`DB: ${dbName}  collections: ${collections.length}`);
  for (const info of collections) {
    const name = info.name;
    const count = await db.collection(name).estimatedDocumentCount();
    console.log(`\n=== ${name}  (est ${count}) ===`);
    if (count === 0) continue;
    // A representative sample, newest-first where there's a createdAt.
    const docs = await db.collection(name)
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .limit(3)
      .toArray();
    let printed = 0;
    for (const doc of docs) {
      if (printed >= 3) break;
      const { _id, ...rest } = doc;
      // Trim long blobs/arrays for readability.
      const trimmed = {};
      for (const [k, v] of Object.entries(rest)) {
        if (typeof v === "string" && v.length > 80) {
          trimmed[k] = `${v.slice(0, 60)}…(${v.length} chars)`;
        } else if (Array.isArray(v) && v.length > 8) {
          trimmed[k] = `[${v.length} items] ${JSON.stringify(v.slice(0, 3)).slice(0, 80)}…`;
        } else if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 12) {
          trimmed[k] = `{${Object.keys(v).length} keys}`;
        } else {
          trimmed[k] = v;
        }
      }
      console.log(`  _id=${String(_id)}`);
      console.log(`    ${JSON.stringify(trimmed).slice(0, 500)}`);
      printed += 1;
    }
  }
  await client.close();
}

main().catch((err) => {
  console.error("FAILED", err);
  process.exit(1);
});
