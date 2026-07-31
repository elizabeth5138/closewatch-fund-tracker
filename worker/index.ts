/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ALPHA_VANTAGE_API_KEY?: string;
  INGEST_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(
    _controller: { scheduledTime: number; cron: string },
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const invokedAt = new Date();
    if (!env.ALPHA_VANTAGE_API_KEY) {
      const { recordFailedIngestionRun } = await import("../lib/ingestion.ts");
      ctx.waitUntil(recordFailedIngestionRun(
        env.DB,
        "configuration",
        "ALPHA_VANTAGE_API_KEY is unset.",
        invokedAt,
        "scheduled",
      ).then((runId) => {
        console.error("Scheduled ingestion configuration failure", { runId });
      }).catch((error) => {
        console.error("Unable to persist scheduled configuration failure", {
          error: error instanceof Error ? error.message : String(error),
        });
      }));
      return;
    }
    const { runDailyIngestion } = await import("../lib/ingestion.ts");
    const { AlphaVantageProvider } = await import("../lib/provider.ts");
    ctx.waitUntil(
      runDailyIngestion(
        env.DB,
        new AlphaVantageProvider(env.ALPHA_VANTAGE_API_KEY),
        invokedAt,
        "scheduled",
      ).then((summary) => {
        console.log("Scheduled ingestion complete", JSON.stringify(summary));
      }).catch((error) => {
        console.error("Scheduled ingestion failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  },
};

export default worker;
