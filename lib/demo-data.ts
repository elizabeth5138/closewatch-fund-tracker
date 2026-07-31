export type DashboardFund = {
  id: string;
  ticker: string;
  name: string;
  kind: "ETF" | "CEF";
  price: string;
  sessionDate: string;
  status:
    | "priced"
    | "pending"
    | "missing"
    | "no_trade"
    | "suspended"
    | "not_listed";
  returns: { oneDay: string; oneWeek: string; oneMonth: string; ytd: string };
  sparkline: number[];
};

export const dashboardFunds: DashboardFund[] = [
  {
    id: "fund_spy",
    ticker: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    kind: "ETF",
    price: "$636.18",
    sessionDate: "29 Jul 2026",
    status: "priced",
    returns: { oneDay: "+0.42%", oneWeek: "+1.08%", oneMonth: "+2.61%", ytd: "+8.34%" },
    sparkline: [46, 44, 47, 43, 39, 38, 34, 36, 31, 28, 30, 25],
  },
  {
    id: "fund_qqq",
    ticker: "QQQ",
    name: "Invesco QQQ Trust",
    kind: "ETF",
    price: "$571.04",
    sessionDate: "29 Jul 2026",
    status: "priced",
    returns: { oneDay: "+0.71%", oneWeek: "+1.82%", oneMonth: "+4.05%", ytd: "+11.72%" },
    sparkline: [48, 45, 43, 44, 39, 35, 37, 31, 29, 26, 22, 18],
  },
  {
    id: "fund_bnd",
    ticker: "BND",
    name: "Vanguard Total Bond Market ETF",
    kind: "ETF",
    price: "$73.82",
    sessionDate: "29 Jul 2026",
    status: "priced",
    returns: { oneDay: "−0.08%", oneWeek: "+0.22%", oneMonth: "+0.48%", ytd: "+2.16%" },
    sparkline: [35, 34, 36, 35, 33, 34, 32, 33, 31, 31, 30, 29],
  },
  {
    id: "fund_usa",
    ticker: "USA",
    name: "Liberty All-Star Equity Fund",
    kind: "CEF",
    price: "$7.14",
    sessionDate: "29 Jul 2026",
    status: "no_trade",
    returns: { oneDay: "0.00%", oneWeek: "+0.56%", oneMonth: "+1.42%", ytd: "+5.31%" },
    sparkline: [38, 35, 35, 33, 31, 31, 30, 27, 28, 26, 26, 24],
  },
];
