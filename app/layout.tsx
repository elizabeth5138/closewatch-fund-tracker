import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const imageUrl = host ? `${protocol}://${host}/og.png` : undefined;
  const title = "Closewatch — Fund Close Monitor";
  const description =
    "Previous-close monitoring for US-listed, USD-denominated ETFs and closed-end funds.";

  return {
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: imageUrl
      ? {
          title,
          description,
          type: "website",
          images: [{ url: imageUrl, width: 1200, height: 630 }],
        }
      : undefined,
    twitter: imageUrl
      ? {
          card: "summary_large_image",
          title,
          description,
          images: [imageUrl],
        }
      : undefined,
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
