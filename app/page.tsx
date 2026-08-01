import TrackerDashboard from "./TrackerDashboard";
import marketData from "../public/data/funds.json";
import {
  dashboardFromMarketData,
  type MarketSnapshot,
} from "../lib/dashboard";

export default function Home() {
  const snapshot = dashboardFromMarketData(marketData as MarketSnapshot);
  return <TrackerDashboard snapshot={snapshot} />;
}
