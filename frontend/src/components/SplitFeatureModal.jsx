'use client';

import { useState, useEffect } from 'react';
import {
  Scissors,
  X,
  Hash,
  Ruler,
  Compass,
  Check,
  Tag,
  Plus,
  Trash2,
  Sparkles,
  Layers,
  Info,
} from 'lucide-react';

/**
 * SplitFeatureModal Component — QGIS Scientific Geometric Split & Multipart Separation Standard
 * Kathmandu Metropolitan City (काठमाडौँ महानगरपालिका)
 * 
 * Supports both:
 * 1. Line-blade cut of Singlepart / Multipart features into N parts.
 * 2. Automatic "Multipart to Singleparts" separation of composite geometries into individual features.
 * Preserves ALL resulting parts without dropping any non-intersected or constituent components.
 */
export default function SplitFeatureModal({
  isOpen,
  onClose,
  splitData,
  onConfirmSplit,
  saving = false,
}) {
  const originalId = splitData?.feature_id || '';
  const originalProps = splitData?.original_properties || {};
  const rawParts = splitData?.parts || [];
  const isMultipart = !!splitData?.is_multipart;

  // Active tab index for attribute editor
  const [activeTab, setActiveTab] = useState(0);

  // Strategy: 'keep_p1' | 'new_all' | 'custom'
  const [idStrategy, setIdStrategy] = useState('keep_p1');

  // Dynamic array of IDs per part
  const [partIds, setPartIds] = useState(() =>
    rawParts.map((pt, idx) => {
      if (idx === 0) return String(originalId);
      return String(pt.suggested_id || `${originalId}_${String.fromCharCode(65 + idx)}`);
    })
  );

  // Dynamic array of attribute objects per part
  const [partsAttrs, setPartsAttrs] = useState(() =>
    rawParts.map((pt, idx) => {
      const p = { ...originalProps };
      const letter = String.fromCharCode(65 + idx);
      if (p.bldg_code) p.bldg_code = `${originalProps.bldg_code}-${letter}`;
      if (p.road_code) p.road_code = `${originalProps.road_code}-${letter}`;
      return p;
    })
  );

  // New field inputs for currently selected part tab
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  // Update IDs and attributes whenever splitData or strategy changes
  useEffect(() => {
    if (!splitData) return;
    const parts = splitData.parts || [];
    const origId = splitData.feature_id || '';
    const origProps = splitData.original_properties || {};

    setActiveTab(0);
    setPartIds(
      parts.map((pt, idx) => {
        if (idStrategy === 'keep_p1' && idx === 0) return String(origId);
        if (idStrategy === 'new_all') return `${origId}_Part${idx + 1}`;
        return String(pt.suggested_id || `${origId}_${String.fromCharCode(65 + idx)}`);
      })
    );
    setPartsAttrs(
      parts.map((pt, idx) => {
        const p = { ...origProps };
        const letter = String.fromCharCode(65 + idx);
        if (p.bldg_code) p.bldg_code = `${origProps.bldg_code}-${letter}`;
        if (p.road_code) p.road_code = `${origProps.road_code}-${letter}`;
        return p;
      })
    );
  }, [splitData, idStrategy]);

  if (!isOpen || !splitData) return null;

  const handleAttrChange = (partIdx, key, value) => {
    setPartsAttrs((prev) => {
      const updated = [...prev];
      updated[partIdx] = { ...(updated[partIdx] || {}), [key]: value };
      return updated;
    });
  };

  const handleRemoveAttr = (partIdx, key) => {
    setPartsAttrs((prev) => {
      const updated = [...prev];
      const cur = { ...(updated[partIdx] || {}) };
      delete cur[key];
      updated[partIdx] = cur;
      return updated;
    });
  };

  const handleAddField = (e) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    const k = newKey.trim().replace(/[^a-zA-Z0-9_]/g, '_');
    setPartsAttrs((prev) => {
      const updated = [...prev];
      updated[activeTab] = { ...(updated[activeTab] || {}), [k]: newVal };
      return updated;
    });
    setNewKey('');
    setNewVal('');
  };

  const handleConfirm = () => {
    for (let i = 0; i < rawParts.length; i++) {
      const id = (partIds[i] || '').trim();
      if (!id) {
        alert(`कृपया भाग ${i + 1} का लागि मान्य Unique ID प्रविष्ट गर्नुहोस्।`);
        return;
      }
    }

    // Check uniqueness across assigned IDs
    const idSet = new Set(partIds.map((id) => (id || '').trim()));
    if (idSet.size !== partIds.length) {
      alert('सबै भागहरूका ID एक आपसमा फरक फरक (Unique) हुनुपर्दछ।');
      return;
    }

    const confirmedParts = rawParts.map((pt, idx) => {
      const assignedId = (partIds[idx] || '').trim();
      const currentPartAttrs = partsAttrs[idx] || { ...originalProps };
      return {
        id: assignedId,
        geometry: pt.geometry,
        properties: {
          ...currentPartAttrs,
          _id: assignedId,
        },
      };
    });

    onConfirmSplit({
      originalFeatureId: splitData?.feature_id || originalId,
      layerId: splitData?.layer_id,
      parts: confirmedParts,
    });
  };

  const currentAttrs = partsAttrs[activeTab] || {};

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-fade-in font-sans">
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92dvh] overflow-hidden flex flex-col animate-scale-up"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-gov-red-700 to-rose-800 text-white p-4 sm:px-5 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-xs border border-white/30 flex items-center justify-center shrink-0 shadow-inner">
              <Scissors className="w-5 h-5 text-rose-100" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.2 rounded text-rose-100">
                  {isMultipart ? 'QGIS मल्टिपार्ट विभाजन (Multipart to Singleparts)' : 'QGIS शैली ज्यामिति विभाजन'}
                </span>
                <span className="text-[10px] text-rose-200 font-mono">
                  #{originalId}
                </span>
              </div>
              <h2 className="text-sm sm:text-base font-bold font-nepali text-white truncate leading-snug">
                {isMultipart
                  ? `मल्टिपार्ट फिचर विभाजन (${rawParts.length} वटा एकल फिचरहरू)`
                  : 'फिचर विभाजन विवरण तथा विशेषता सम्पादन (Feature Split)'}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors shrink-0 cursor-pointer"
            title="बन्द गर्नुहोस्"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 text-xs scrollbar-thin">
          {/* Multipart Notice Banner */}
          {isMultipart && (
            <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 flex items-start gap-2.5 text-amber-900">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed font-nepali">
                <strong>मल्टिपार्ट फिचर (Multipart Feature):</strong> यो फिचरमा{' '}
                <strong>{rawParts.length} वटा छुट्टाछुट्टै भागहरू</strong> छन्। विभाजन गर्दा रेखा काट्न आवश्यक छैन;
                यी सबै भागहरू स्वतः अलग-अलग एकल फिचरहरू (Singlepart Features) मा रूपान्तरण हुनेछन्।
              </div>
            </div>
          )}

          {/* Top Metric Comparison Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {rawParts.map((pt, idx) => {
              const assignedId = partIds[idx] || '—';
              const isSelected = activeTab === idx;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setActiveTab(idx)}
                  className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-rose-50/80 border-rose-300 ring-2 ring-rose-400/40 shadow-xs'
                      : 'bg-slate-50 border-slate-200 hover:bg-slate-100/80'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-bold font-nepali text-slate-800 flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${idx === 0 ? 'bg-gov-blue-600' : 'bg-emerald-600'}`} />
                      भाग {idx + 1} (Part {idx + 1})
                    </span>
                  </div>
                  <div className="text-[10px] font-mono font-bold text-slate-700 bg-white px-1.5 py-0.5 rounded border border-slate-200 truncate mb-1">
                    ID: #{assignedId}
                  </div>
                  <div className="space-y-0.5 font-mono text-[10px] text-slate-600">
                    {pt.area_sqm > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 font-sans">क्षेत्रफल:</span>
                        <strong className="text-slate-800">{pt.area_sqm.toLocaleString()} m²</strong>
                      </div>
                    )}
                    {pt.length_m > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 font-sans">लम्बाइ:</span>
                        <strong className="text-slate-800">{pt.length_m.toLocaleString()} m</strong>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Section 1: Unique ID Assignment Strategy (QGIS Practice) */}
          <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-2.5">
            <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5 text-gov-red-600" />
              विभाजित फिचरहरूको Unique ID निर्धारण रणनीति (ID Assignment Strategy):
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className={`p-2 rounded-lg border flex items-start gap-2 cursor-pointer transition-all ${
                idStrategy === 'keep_p1' ? 'bg-white border-gov-red-500 shadow-xs' : 'bg-white/60 border-slate-200'
              }`}>
                <input
                  type="radio"
                  name="id_strat"
                  checked={idStrategy === 'keep_p1'}
                  onChange={() => setIdStrategy('keep_p1')}
                  className="mt-0.5 text-gov-red-600 focus:ring-gov-red-500"
                />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-slate-800 block font-nepali leading-tight">
                    भाग १ लाई पुरानो ID ({originalId})
                  </span>
                  <span className="text-[9px] text-slate-500 block font-mono">
                    बाँकीलाई नयाँ ID (_B, _C...)
                  </span>
                </div>
              </label>

              <label className={`p-2 rounded-lg border flex items-start gap-2 cursor-pointer transition-all ${
                idStrategy === 'new_all' ? 'bg-white border-gov-red-500 shadow-xs' : 'bg-white/60 border-slate-200'
              }`}>
                <input
                  type="radio"
                  name="id_strat"
                  checked={idStrategy === 'new_all'}
                  onChange={() => setIdStrategy('new_all')}
                  className="mt-0.5 text-gov-red-600 focus:ring-gov-red-500"
                />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-slate-800 block font-nepali leading-tight">
                    सबैलाई नयाँ Unique ID दिने
                  </span>
                  <span className="text-[9px] text-slate-500 block font-mono">
                    {originalId}_Part1, Part2...
                  </span>
                </div>
              </label>

              <label className={`p-2 rounded-lg border flex items-start gap-2 cursor-pointer transition-all ${
                idStrategy === 'custom' ? 'bg-white border-gov-red-500 shadow-xs' : 'bg-white/60 border-slate-200'
              }`}>
                <input
                  type="radio"
                  name="id_strat"
                  checked={idStrategy === 'custom'}
                  onChange={() => setIdStrategy('custom')}
                  className="mt-0.5 text-gov-red-600 focus:ring-gov-red-500"
                />
                <div className="min-w-0">
                  <span className="text-[11px] font-bold text-slate-800 block font-nepali leading-tight">
                    हातैले आफूले चाहेको ID लेख्ने
                  </span>
                  <span className="text-[9px] text-slate-500 block font-nepali">
                    Manual Custom IDs
                  </span>
                </div>
              </label>
            </div>

            {/* Editable ID Fields for all parts */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1">
              {rawParts.map((_, idx) => (
                <div key={idx}>
                  <label className="text-[10px] font-bold text-slate-600 mb-0.5 block font-nepali">
                    भाग {idx + 1} को अन्तिम ID:
                  </label>
                  <input
                    type="text"
                    value={partIds[idx] || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPartIds((prev) => {
                        const copy = [...prev];
                        copy[idx] = val;
                        return copy;
                      });
                      setIdStrategy('custom');
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-mono text-xs focus:ring-1 focus:ring-gov-red-500 focus:border-gov-red-500 bg-white"
                    placeholder={`Part ${idx + 1} ID`}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Section 2: Attribute Editor Tabs (Editable for each part) */}
          <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2 flex-wrap gap-2">
              <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5">
                {rawParts.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveTab(idx)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold font-nepali transition-all cursor-pointer whitespace-nowrap ${
                      activeTab === idx
                        ? 'bg-gov-blue-800 text-white shadow-xs'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    भाग {idx + 1} का विशेषताहरू (Part {idx + 1})
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-slate-500 font-nepali">
                {Object.keys(currentAttrs).filter((k) => !k.startsWith('_')).length} फिल्डहरू
              </span>
            </div>

            {/* Attributes Grid for Active Part */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1 scrollbar-thin">
              {Object.entries(currentAttrs)
                .filter(([k]) => !k.startsWith('_') && k !== 'id' && k !== 'geometry')
                .map(([key, val]) => (
                  <div
                    key={key}
                    className="p-2 rounded-lg bg-white border border-slate-200 flex flex-col justify-between gap-1 shadow-2xs group"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider truncate font-mono">
                        {key}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveAttr(activeTab, key)}
                        className="text-slate-300 hover:text-gov-red-600 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                        title="हटाउनुहोस्"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={val !== null && val !== undefined ? String(val) : ''}
                      onChange={(e) => handleAttrChange(activeTab, key, e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-200 rounded font-nepali focus:ring-1 focus:ring-gov-blue-500 bg-slate-50 focus:bg-white"
                      placeholder="मान लेख्नुहोस्..."
                    />
                  </div>
                ))}
            </div>

            {/* Quick Add Custom Field to Active Part */}
            <form onSubmit={handleAddField} className="flex items-center gap-2 pt-1 border-t border-slate-200">
              <input
                type="text"
                placeholder="नयाँ फिल्ड नाम (e.g. ward_no)"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white font-mono"
              />
              <input
                type="text"
                placeholder="मान (Value)"
                value={newVal}
                onChange={(e) => setNewVal(e.target.value)}
                className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white font-nepali"
              />
              <button
                type="submit"
                disabled={!newKey.trim()}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> थप्नुहोस्
              </button>
            </form>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-100 px-4 py-3 sm:px-5 border-t border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-[11px] text-slate-500 font-nepali">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            <span>पुष्टि गरेपछि {rawParts.length} वटा नयाँ एकल फिचरहरू सुरक्षित हुनेछन्।</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3.5 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-200 text-xs font-bold font-nepali transition-colors cursor-pointer"
            >
              रद्द गर्नुहोस् (Cancel)
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={saving}
              className="px-4 py-2 rounded-xl bg-gov-red-700 hover:bg-gov-red-800 disabled:opacity-50 text-white text-xs font-bold font-nepali shadow-md shadow-gov-red-900/20 flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>{saving ? 'विभाजन हुँदैछ...' : 'विभाजन निश्चित गर्नुहोस् (Confirm Split)'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
