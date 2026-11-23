import './globals.css';
import { AuthProvider } from '../lib/auth';
import PwaRegistrar from '../components/PwaRegistrar';

export const metadata = {
  title: 'काठमाडौँ महानगरपालिका | भू-सूचना तथा नक्साङ्कन प्रणाली (KMC WebGIS)',
  description: 'काठमाडौँ महानगरपालिकाको आधिकारिक भौगोलिक सूचना प्रणाली (Enterprise WebGIS & Spatial Data Infrastructure)',
  keywords: 'KMC, Kathmandu Metropolitan City, GIS, WebGIS, Nepal Government, NDRRMA, Spatial Data, PostGIS',
  applicationName: 'KMC WebGIS',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'KMC WebGIS',
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
        <meta name="theme-color" content="#0447af" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="stylesheet" href="/maplibre-gl.css" />
        <script src="/runtime-config.js" />
      </head>
      <body className="font-sans antialiased bg-slate-100 text-slate-900 w-full h-full fixed inset-0 overflow-hidden">
        <AuthProvider>
          {children}
        </AuthProvider>
        <PwaRegistrar />
      </body>
    </html>
  );
}
