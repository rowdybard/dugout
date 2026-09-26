import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dugout — Sports Paper Bot",
  description: "Live tennis markets. Test dip-and-recovery trading with a fake balance and transparent execution.",
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
