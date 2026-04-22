import type { NextConfig } from "next";

const backendProxyOrigin = process.env.BACKEND_PROXY_ORIGIN?.trim().replace(/\/+$/, "");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    if (!backendProxyOrigin) {
      return [];
    }

    return {
      beforeFiles: [
        {
          source: "/api/h5/:path*",
          destination: `${backendProxyOrigin}/api/h5/:path*`,
        },
        {
          source: "/upload/multipart/:path*",
          destination: `${backendProxyOrigin}/upload/multipart/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
