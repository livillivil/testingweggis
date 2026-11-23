'use client';

import { useEffect } from 'react';

/**
 * Registers the KMC field PWA service worker (`/sw.js`) once the window has loaded.
 * Kept as a tiny client component so the root layout can stay a server component.
 */
export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /* Offline support is progressive; never block the workbench on it. */
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
