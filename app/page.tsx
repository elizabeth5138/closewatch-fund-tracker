import type { Metadata } from "next";
import TrackerDashboard from "./TrackerDashboard";
import {
  type DashboardSnapshot,
  illustrativeSnapshot,
  loadDashboard,
  unavailableSnapshot,
} from "../lib/dashboard.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Closewatch — Fund Close Monitor",
  description:
    "A dependable morning monitor for previous-close fund prices and pipeline health.",
};

export default async function Home() {
  let snapshot: DashboardSnapshot;
  try {
    const { env } = await import("cloudflare:workers");
    const runtime = env as unknown as {
      DB?: D1Database;
      PREVIEW_MODE?: string;
    };
    if (runtime.PREVIEW_MODE === "true") {
      snapshot = illustrativeSnapshot();
    } else if (!runtime.DB) {
      snapshot = unavailableSnapshot();
    } else {
      snapshot = await loadDashboard(runtime.DB);
    }
  } catch {
    snapshot = unavailableSnapshot();
  }
  return <TrackerDashboard snapshot={snapshot} />;
}
