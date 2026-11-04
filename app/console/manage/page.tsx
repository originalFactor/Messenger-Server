import { redirect } from "next/navigation";

export default function LegacyPage() {
  redirect("/messenger?settings=1");
}
