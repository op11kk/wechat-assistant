import type { Metadata } from "next";

import "./globals.css";

const siteIcpNumber = process.env.NEXT_PUBLIC_SITE_ICP_NUMBER?.trim() ?? "";
const sitePsbNumber = process.env.NEXT_PUBLIC_SITE_PSB_NUMBER?.trim() ?? "";
const sitePsbUrl = process.env.NEXT_PUBLIC_SITE_PSB_URL?.trim() ?? "https://beian.mps.gov.cn/#/query/webSearch";
const sitePsbIconUrl = process.env.NEXT_PUBLIC_SITE_PSB_ICON_URL?.trim() ?? "";

export const metadata: Metadata = {
  title: "国内版视频采集系统 MVP",
  description: "基于 Next.js、PostgreSQL 和腾讯云 COS 的国内版视频采集三端系统。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {siteIcpNumber || sitePsbNumber ? (
          <footer className="site-footer">
            <div className="site-footer__inner">
              <p className="site-footer__title">网站备案信息</p>
              <div className="site-footer__links">
                {siteIcpNumber ? (
                  <a href="https://beian.miit.gov.cn/" rel="noreferrer" target="_blank">
                    {siteIcpNumber}
                  </a>
                ) : null}
                {sitePsbNumber ? (
                  <a href={sitePsbUrl} rel="noreferrer" target="_blank">
                    {sitePsbIconUrl ? (
                      <img alt="" aria-hidden="true" className="site-footer__icon" height="18" src={sitePsbIconUrl} width="18" />
                    ) : null}
                    公安备案号 {sitePsbNumber}
                  </a>
                ) : null}
              </div>
            </div>
          </footer>
        ) : null}
      </body>
    </html>
  );
}
