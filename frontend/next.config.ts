import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 關閉 dev 模式左下角的 Next.js 指示器（深色圓形 N 按鈕），避免遮住側欄登出鈕
  devIndicators: false,
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000'] },
  },
}

export default nextConfig
