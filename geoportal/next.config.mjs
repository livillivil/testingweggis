/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  basePath: '/geoportal',
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    const backendUrl = globalThis.process?.env?.['BACKEND_INTERNAL_URL'] || 'http://backend:8000';
    const tileserverUrl = globalThis.process?.env?.['TILESERVER_INTERNAL_URL'] || 'http://tileserver:8080';
    const martinUrl = globalThis.process?.env?.['MARTIN_INTERNAL_URL'] || 'http://martin:3000';
    const geoserverUrl = globalThis.process?.env?.['GEOSERVER_INTERNAL_URL'] || 'http://geoserver:8080/geoserver';
    return [
      {
        // `basePath: false` keeps the API at the origin root (/api/...) even
        // though the portal itself is mounted at /geoportal. Without it the
        // rewrite would become /geoportal/api/* and every direct-port request
        // would 404 (the API only exists at the origin root).
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
        basePath: false,
      },
      {
        source: '/tiles/data/:path*',
        destination: `${backendUrl}/api/tiles/data/:path*`,
        basePath: false,
      },
      {
        source: '/tiles/:path*',
        destination: `${tileserverUrl}/:path*`,
        basePath: false,
      },
      {
        source: '/martin/:path*',
        destination: `${martinUrl}/:path*`,
        basePath: false,
      },
      {
        source: '/geoserver/:path*',
        destination: `${geoserverUrl}/:path*`,
        basePath: false,
      },
    ];
  },
  // Transpile OpenLayers for proper SSR handling
  transpilePackages: ['ol'],
};

export default nextConfig;
