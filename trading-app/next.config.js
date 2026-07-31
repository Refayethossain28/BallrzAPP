/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep server-only SDKs out of the bundler (loaded at runtime by the
  // real-time scoring worker).
  serverExternalPackages: ['firebase-admin', 'web-push'],
}

module.exports = nextConfig
