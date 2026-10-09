import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Attention Manager",
  description: "Local dashboard showing which Claude Code session needs your attention.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
