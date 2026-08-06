import TrackerDashboard from "./TrackerDashboard";
import marketData from "../public/data/funds.json";
import summaryData from "../public/data/session-summary.json";
import {
  dashboardFromMarketData,
  type MarketSnapshot,
  type SessionSummaryData,
} from "../lib/dashboard";

export default function Home() {
  const snapshot = dashboardFromMarketData(
    marketData as MarketSnapshot,
    summaryData as SessionSummaryData,
  );
  return <TrackerDashboard snapshot={snapshot} />;
}
