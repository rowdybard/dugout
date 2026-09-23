import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dugout — MLB & NFL Market Radar",
  description: "Real MLB and NFL market movement. Plain-English explanations. Paper trading.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
