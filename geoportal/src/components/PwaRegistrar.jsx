'use client';

import { useEffect } from 'react';

/**
 * Registers the public GeoPortal service worker under the `/geoportal` basePath.
 * Scope must match `basePath` so the portal PWA never claims the whole origin
 * (the authenticated field workbench owns the root scope).
 */
export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;

    const register = () => {
      navigator.serviceWorker.register('/geoportal/sw.js', { scope: '/geoportal/' }).catch(() => {
        /* Offline support is progressive; never block the portal on it. */
      });
    };

    if (document.readyState === 'complete') {
      register();
      return undefined;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
