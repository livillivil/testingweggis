'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Root Landing Page — Kathmandu Metropolitan City Municipal WebGIS.
 * Unified to strictly present the single authentic "Enter the Geo World of KMC" (काठमाडौँको जियो संसार) gateway.
 */
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/geoportal');
  }, [router]);

  return (
    <div className="w-screen min-h-[100dvh] bg-[#021b44] flex flex-col items-center justify-center text-white text-sm font-nepali gap-3">
      <Loader2 className="w-8 h-8 animate-spin text-sky-400" />
      <span>काठमाडौँको जियो संसारमा प्रवेश गरिँदैछ (Entering the Geo World of KMC)...</span>
    </div>
  );
}
