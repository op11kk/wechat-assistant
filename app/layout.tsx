import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "iosbehind",
  description: "Next.js + TypeScript video collection gateway for WeChat, Supabase and Cloudflare R2.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
