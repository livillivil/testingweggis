'use client';

import { ShieldAlert, RefreshCw } from 'lucide-react';
import { EmblemOfNepal, MunicipalLogo, NepalFlag } from './NepalEmblem';

/**
 * Public maintenance notice shown when the MasterAdmin switches the GeoPortal off.
 * The switch is enforced by the backend (`/api/runtime-config` + `/api/geoportal/*`).
 */
export default function MaintenanceScreen({ reason = '' }) {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-gov-blue-950 flex items-center justify-center p-4">
      <div className="gov-tricolor-bar absolute top-0 inset-x-0" />
      <div className="relative z-10 w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 text-center space-y-4">
        <div className="flex items-center justify-center gap-3">
          <EmblemOfNepal className="w-11 h-11" size={44} />
          <MunicipalLogo className="w-11 h-11" size={44} />
          <NepalFlag className="w-11 h-8 rounded" size={44} />
        </div>

        <div className="flex items-center justify-center gap-2 text-gov-red-700">
          <ShieldAlert className="w-6 h-6" />
          <h1 className="text-lg font-bold font-nepali">जियोपोर्टल मर्मतमा छ</h1>
        </div>
        <p className="text-sm font-bold text-slate-700">GeoPortal is temporarily unavailable</p>

        <p className="text-xs text-slate-600 font-nepali leading-relaxed">
          सार्वजनिक जियोपोर्टल मास्टर प्रशासकद्वारा अस्थायी रूपमा बन्द गरिएको छ। कृपया केही समयपछि
          पुनः प्रयास गर्नुहोस्।
        </p>
        <p className="text-xs text-slate-600 leading-relaxed">
          The public GeoPortal has been disabled by the master administrator. Please try again later.
        </p>

        {reason ? (
          <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-nepali">
            {reason}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gov-blue-800 hover:bg-gov-blue-900 text-white text-xs font-bold transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          पुनः प्रयास गर्नुहोस् (Retry)
        </button>

        <div className="text-[10px] text-slate-500 border-t border-slate-100 pt-3 font-nepali">
          काठमाडौँ महानगरपालिका · Kathmandu Metropolitan City
          <br />
          एकीकृत भू-स्थानिक सूचना प्रणाली (Integrated Geospatial Information System)
        </div>
      </div>
    </div>
  );
}
