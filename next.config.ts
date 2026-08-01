import type { NextConfig } from "next";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const projectPages = Boolean(repositoryName) && !repositoryName.endsWith(".github.io");
const basePath = process.env.GITHUB_ACTIONS === "true" && projectPages
  ? `/${repositoryName}`
  : "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
