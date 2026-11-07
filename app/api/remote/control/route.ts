import { z } from "zod";
import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { controlRelay } from "@/lib/remote-control";
import { deviceIdSchema } from "@/lib/validation";

export const runtime = "nodejs";

const connectionId = z.uuid();
const id = z.uuid();
const packet = z.discriminatedUnion("kind", [
  z.strictObject({ connectionId, kind: z.literal("advertise"), enabled: z.boolean(), name: z.string().max(120) }),
  z.strictObject({ connectionId, kind: z.literal("request"), id, target: deviceIdSchema, payload: z.record(z.string(), z.unknown()) }),
  z.strictObject({ connectionId, kind: z.literal("reply"), id, done: z.boolean(), payload: z.record(z.string(), z.unknown()) }),
  z.strictObject({ connectionId, kind: z.literal("signal"), id, optionId: z.string().min(1).max(256).optional() }),
]);

export async function GET() {
  const session = await requireUserSession();
  if (!session?.sid) return jsonError("Unauthorized.", 401);
  return jsonOk({ devices: controlRelay().devices(session.sub) });
}

export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session?.sid) return jsonError("Unauthorized.", 401);

  const reader = request.body?.getReader();
  if (!reader) return jsonError("Missing control payload.", 400);
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256_000) {
        await reader.cancel();
        return jsonError("Control payload is too large.", 413);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return jsonError("Could not read control payload.", 400);
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return jsonError("Invalid control payload.", 400);
  }
  const parsed = packet.safeParse(data);
  if (!parsed.success) return jsonError("Invalid control payload.", 400);
  const frame = parsed.data;
  const relay = controlRelay();
  const source = relay.authenticate(session.sub, session.sid, frame.connectionId);
  if (!source) return jsonError("Control connection expired.", 403);
  if (frame.kind === "request") {
    const status = relay.request(source, frame.target, frame.id, frame.payload);
    return status === 202 ? jsonOk({ delivered: true }, 202) : jsonError("Control request unavailable.", status);
  }
  const delivered = frame.kind === "advertise"
    ? relay.advertise(source, frame.enabled, frame.name)
    : frame.kind === "reply"
      ? relay.reply(source, frame.id, frame.payload, frame.done)
      : relay.signal(source, frame.id, frame.optionId);
  return delivered ? jsonOk({ delivered: true }, 202) : jsonError("Control request unavailable.", 409);
}
