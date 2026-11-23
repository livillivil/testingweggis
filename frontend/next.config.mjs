/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    const backendUrl = globalThis.process?.env?.['BACKEND_INTERNAL_URL'] || 'http://backend:8000';
    const tileserverUrl = globalThis.process?.env?.['TILESERVER_INTERNAL_URL'] || 'http://tileserver:8080';
    const geoportalUrl = globalThis.process?.env?.['GEOPORTAL_INTERNAL_URL'] || 'http://geoportal:3000';
    const martinUrl = globalThis.process?.env?.['MARTIN_INTERNAL_URL'] || 'http://martin:3000';
    const geoserverUrl = globalThis.process?.env?.['GEOSERVER_INTERNAL_URL'] || 'http://geoserver:8080/geoserver';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/tiles/data/:path*',
        destination: `${backendUrl}/api/tiles/data/:path*`,
      },
      {
        source: '/tiles/:path*',
        destination: `${tileserverUrl}/:path*`,
      },
      {
        source: '/martin/:path*',
        destination: `${martinUrl}/:path*`,
      },
      {
        source: '/geoserver/:path*',
        destination: `${geoserverUrl}/:path*`,
      },
      {
        source: '/geoportal',
        destination: `${geoportalUrl}/geoportal`,
      },
      {
        source: '/geoportal/:path*',
        destination: `${geoportalUrl}/geoportal/:path*`,
      },
    ];
  },
  // Transpile OpenLayers for proper SSR handling
  transpilePackages: ['ol'],
};

export default nextConfig;
