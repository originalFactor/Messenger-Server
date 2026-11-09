export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Credential-free identity check for native local development discovery. */
export function GET() {
  if (process.env.NODE_ENV !== "development") {
    return new Response(null, { status: 404 });
  }
  return Response.json(
    { service: "messenger-cloud", version: 1, development: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
