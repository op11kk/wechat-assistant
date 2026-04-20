import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "微信公众号视频上传 H5",
  description: "基于 Next.js、PostgreSQL 和腾讯云 COS 的微信公众号视频上传页面。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
