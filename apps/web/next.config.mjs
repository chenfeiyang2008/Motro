/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3000";
    // 浏览器走同源 /api/*，由 Web 代理到版本化 API，避免 CORS 并保持 cookie 语义。
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
