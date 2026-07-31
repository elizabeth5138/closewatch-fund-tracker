import {
  IngestionBusyError,
  runDailyIngestion,
} from "../../../lib/ingestion.ts";
import { AlphaVantageProvider } from "../../../lib/provider.ts";

export const dynamic = "force-dynamic";

async function secureTokenMatch(supplied: string | null, expected: string) {
  if (!supplied?.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const actual = new Uint8Array(actualHash);
  const wanted = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    difference |= actual[index] ^ wanted[index];
  }
  return difference === 0;
}

type RuntimeEnv = {
  DB?: D1Database;
  ALPHA_VANTAGE_API_KEY?: string;
  INGEST_TOKEN?: string;
};

export async function POST(request: Request) {
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as RuntimeEnv;
  if (!runtime.INGEST_TOKEN) {
    return Response.json(
      { error: "Ingestion authorization is not configured." },
      { status: 503 },
    );
  }
  const supplied = request.headers.get("authorization");
  if (!(await secureTokenMatch(supplied, runtime.INGEST_TOKEN))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!runtime.DB) {
    return Response.json({ error: "Database binding unavailable." }, { status: 503 });
  }
  if (!runtime.ALPHA_VANTAGE_API_KEY) {
    return Response.json({ error: "Price provider is not configured." }, { status: 503 });
  }

  try {
    const summary = await runDailyIngestion(
      runtime.DB,
      new AlphaVantageProvider(runtime.ALPHA_VANTAGE_API_KEY),
      new Date(),
      "manual",
    );
    return Response.json(summary);
  } catch (error) {
    if (error instanceof IngestionBusyError) {
      return Response.json(
        { error: "Ingestion is already active or cooling down." },
        {
          status: 429,
          headers: { "retry-after": String(error.retryAfterSeconds) },
        },
      );
    }
    console.error("Manual ingestion failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Ingestion failed." }, { status: 502 });
  }
}
