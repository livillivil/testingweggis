import './globals.css';
import PwaRegistrar from '../components/PwaRegistrar';

export const metadata = {
  title: 'काठमाडौँ महानगरपालिका | एकीकृत नगर सूचना प्रणाली तथा खुला भू-स्थानिक पोर्टल (KMC Public GeoPortal)',
  description: 'काठमाडौँ महानगरपालिकाको आधिकारिक एकीकृत नगर सूचना प्रणाली तथा खुला भू-स्थानिक पोर्टल',
  keywords: 'KMC, Kathmandu, GeoPortal, GIS, WebGIS, PostGIS, Nepal Open Data, Spatial Infrastructure',
  applicationName: 'KMC GeoPortal',
  appleWebApp: {
    capable: true,
    title: 'KMC GeoPortal',
    statusBarStyle: 'default',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0447af',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ne">
      <head>
        {/*
          The GeoPortal runs under Next.js `basePath: '/geoportal'`, so every
          public URL (manifest, service worker, icons, runtime config) must
          carry the basePath prefix explicitly.
        */}
        <link rel="manifest" href="/geoportal/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/geoportal/apple-touch-icon.png" />
        <link rel="icon" type="image/png" href="/geoportal/assets/KMC.png" />
        <meta name="theme-color" content="#0447af" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="KMC GeoPortal" />
        <link rel="stylesheet" href="/geoportal/maplibre-gl.css" />
        <script src="/geoportal/runtime-config.js" />
      </head>
      <body className="w-full h-full fixed inset-0 overflow-hidden bg-slate-100 text-slate-900 font-sans antialiased">
        {children}
        <PwaRegistrar />
      </body>
    </html>
  );
}
