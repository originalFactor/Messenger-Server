// Per-user entity audit: for each user, count their agents/conversations/usage_logs/redemptions.
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME ?? "messenger";
const client = new MongoClient(uri, { maxPoolSize: 3, connectTimeoutMS: 5_000, serverSelectionTimeoutMS: 5_000 });

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const users = await db.collection("users").find({}, { projection: { _id: 1, email: 1, role: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray();
  console.log(`Users: ${users.length}\n`);
  for (const u of users) {
    const [agents, convs, usage, redemps, quotas, cards] = await Promise.all([
      db.collection("agents").countDocuments({ userId: u._id }),
      db.collection("conversations").countDocuments({ userId: u._id }),
      db.collection("usage_logs").countDocuments({ userId: u._id }),
      db.collection("redemptions").countDocuments({ userId: u._id }),
      db.collection("user_quotas").countDocuments({ userId: u._id }),
      db.collection("card_keys").countDocuments({ createdByUserId: u._id }),
    ]);
    // usage time span
    const first = await db.collection("usage_logs").find({ userId: u._id }).sort({ createdAt: 1 }).limit(1).next();
    const last = await db.collection("usage_logs").find({ userId: u._id }).sort({ createdAt: -1 }).limit(1).next();
    const span = first && last ? `${new Date(first.createdAt).toISOString().slice(0,16)} → ${new Date(last.createdAt).toISOString().slice(0,16)}` : "no usage";
    console.log(`${u.email}  [${u.role}]  id=${u._id}`);
    console.log(`  createdAt=${new Date(u.createdAt).toISOString()}`);
    console.log(`  agents=${agents}  conversations=${convs}  usage_logs=${usage}  redemptions=${redemps}  quotas=${quotas}  cards_created=${cards}`);
    console.log(`  usage span: ${span}\n`);
  }
  // also: the deleted market_agent "test" and tombstoned conversations
  const delAgents = await db.collection("agents").countDocuments({ deleted: true });
  const delConvs = await db.collection("conversations").countDocuments({ deleted: true });
  console.log(`Tombstones: agents(deleted=true)=${delAgents}  conversations(deleted=true)=${delConvs}`);
  await client.close();
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
