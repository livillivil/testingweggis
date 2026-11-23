'use client';

import { useState, useEffect } from 'react';
import {
  Combine,
  X,
  Layers,
  Ruler,
  Compass,
  Check,
  AlertTriangle,
  Loader2,
  Tag,
  Hash,
  Copy,
  Plus,
  Trash2,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';

/**
 * MergeFeaturesModal Component — QGIS Scientific Geometric Merge Standard
 * Kathmandu Metropolitan City (काठमाडौँ महानगरपालिका)
 * 
 * Allows users to review all selected features to merge, select the primary feature
 * whose ID and attributes serve as the baseline template, choose Union vs Multi-Feature mode,
 * and interactively inspect/modify any attribute value before performing the merge.
 */
export default function MergeFeaturesModal({
  isOpen,
  onClose,
  features = [],
  layerId,
  onConfirmMerge,
  saving = false,
}) {
  const getFid = (f) => f?.id ?? f?.properties?._id ?? f?.properties?.id ?? '';

  // Selected primary feature ID
  const [primaryId, setPrimaryId] = useState(String(getFid(features?.[0])));
  const [customId, setCustomId] = useState(String(getFid(features?.[0])));
  const [mergeMode, setMergeMode] = useState('union'); // 'union' | 'multifeature'

  // Editable attributes for the merged feature
  const [attributes, setAttributes] = useState({});

  // New field inputs
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  // Sync primaryId whenever modal opens or features change
  useEffect(() => {
    if (isOpen && features && features.length > 0) {
      const exists = features.some((f) => String(getFid(f)) === String(primaryId));
      if (!exists) {
        setPrimaryId(String(getFid(features[0])));
      }
    }
  }, [isOpen, features]);

  // Primary feature object
  const primaryFeature = (features || []).find((f) => String(getFid(f)) === String(primaryId)) || features?.[0];

  // Whenever primaryId changes, update customId and fill attributes from the primary feature
  useEffect(() => {
    if (primaryFeature) {
      setCustomId(String(getFid(primaryFeature)));
      const props = { ...(primaryFeature.properties || {}) };
      // Filter internal fields
      const cleanProps = {};
      Object.entries(props).forEach(([k, v]) => {
        if (!k.startsWith('_')) cleanProps[k] = v;
      });
      setAttributes(cleanProps);
    }
  }, [primaryId, primaryFeature]);

  if (!isOpen || !features || features.length < 2) return null;

  const handleAttrChange = (key, value) => {
    setAttributes((prev) => ({ ...prev, [key]: value }));
  };

  const handleRemoveAttr = (key) => {
    setAttributes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleAddField = (e) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    const k = newKey.trim().replace(/[^a-zA-Z0-9_]/g, '_');
    setAttributes((prev) => ({ ...prev, [k]: newVal }));
    setNewKey('');
    setNewVal('');
  };

  const handleTakeValueFromFeature = (key, val) => {
    setAttributes((prev) => ({ ...prev, [key]: val }));
  };

  const handleConfirm = () => {
    if (!customId.trim()) {
      alert('कृपया एकीकरण पछिको फिचरका लागि मान्य ID प्रविष्ट गर्नुहोस्।');
      return;
    }

    const payload = {
      feature_ids: features.map((f) => f.id || f.properties?._id || f.properties?.id).filter(Boolean),
      features: features,
      primary_feature_id: primaryId,
      custom_id: customId.trim(),
      merge_mode: mergeMode,
      attributes: {
        ...attributes,
        _id: customId.trim(),
      },
    };

    onConfirmMerge(payload);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-fade-in font-sans">
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92dvh] overflow-hidden flex flex-col animate-scale-up"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-violet-700 to-purple-800 text-white p-4 sm:px-5 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-xs border border-white/30 flex items-center justify-center shrink-0 shadow-inner">
              <Combine className="w-5 h-5 text-violet-100" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.2 rounded text-violet-100">
                  QGIS शैली फिचर एकीकरण
                </span>
                <span className="text-[10px] text-violet-200 font-mono">
                  {features.length} फिचरहरू छानिएका
                </span>
              </div>
              <h2 className="text-sm sm:text-base font-bold font-nepali text-white truncate leading-snug">
                फिचर एकीकरण तथा विशेषता व्यवस्थापन (Feature Merge)
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
          {/* Section 1: Features to Merge & Primary Feature Selection */}
          <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-violet-600" />
                मुख्य फिचर छान्नुहोस् (Primary / Template Feature):
              </label>
              <span className="text-[10px] text-slate-500 font-nepali">
                छानिएको मुख्य फिचरको विवरण स्वतः भरिनेछ
              </span>
            </div>

            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1 scrollbar-thin">
              {features.map((feat, fIdx) => {
                const fid = getFid(feat);
                const isPrimary = String(fid) === String(primaryId);
                const props = feat.properties || {};
                const label =
                  props.bldg_code || props.road_name || props.road_code || props.name || props.owner_name || `फिचर #${fid || fIdx + 1}`;
                return (
                  <label
                    key={fid || fIdx}
                    className={`p-2 rounded-lg border flex items-center justify-between gap-2 cursor-pointer transition-all ${
                      isPrimary
                        ? 'bg-violet-50 border-violet-400 ring-1 ring-violet-300 shadow-xs'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="radio"
                        name="primary_feature_select"
                        checked={isPrimary}
                        onChange={() => setPrimaryId(String(fid))}
                        className="text-violet-600 focus:ring-violet-500"
                      />
                      <div className="truncate">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-slate-800 text-[11px] font-nepali truncate">
                            {label}
                          </span>
                          <span className="font-mono text-[10px] text-slate-500 bg-slate-100 px-1 rounded">
                            #{fid || fIdx + 1}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-500 block truncate font-sans">
                          {feat.geometry?.type || 'Geometry'} &middot; {Object.keys(props).filter((k) => !k.startsWith('_')).length} फिल्डहरू
                        </span>
                      </div>
                    </div>
                    {isPrimary && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold font-nepali bg-violet-700 text-white shrink-0">
                        मुख्य (Primary)
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Section 2: ID & Merge Mode */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Final Feature ID */}
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-1.5">
              <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-violet-600" />
                एकीकृत फिचरको अन्तिम ID (Final Unique ID):
              </label>
              <input
                type="text"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-mono text-xs focus:ring-1 focus:ring-violet-500 focus:border-violet-500 bg-white"
                placeholder="Final Feature ID"
              />
              <span className="text-[9.5px] text-slate-500 block font-nepali">
                मुख्य फिचरको ID राखिएको छ वा नयाँ ID लेख्न सक्नुहुन्छ
              </span>
            </div>

            {/* Merge Mode Toggle */}
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-1.5">
              <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-violet-600" />
                एकीकरण प्रकार (Merge Mode):
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setMergeMode('union')}
                  className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                    mergeMode === 'union'
                      ? 'bg-violet-700 text-white border-violet-800 shadow-xs'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <span className="block font-bold text-[10.5px] font-nepali leading-tight">
                    Spatial Singlepart Merge (QGIS)
                  </span>
                  <span className={`block text-[9px] ${mergeMode === 'union' ? 'text-violet-200' : 'text-slate-500'}`}>
                    सिमाना मिलाई एउटै भाग बनाउने (Singlepart)
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setMergeMode('multifeature')}
                  className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                    mergeMode === 'multifeature'
                      ? 'bg-violet-700 text-white border-violet-800 shadow-xs'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <span className="block font-bold text-[10.5px] font-nepali leading-tight">
                    Multi-Feature
                  </span>
                  <span className={`block text-[9px] ${mergeMode === 'multifeature' ? 'text-violet-200' : 'text-slate-500'}`}>
                    छुट्टाछुट्टै भाग राख्ने
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* Section 3: Attribute Table Editor (Customize any attribute before merge) */}
          <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-2.5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-violet-600" />
                एकीकृत फिचरका विशेषताहरू (Merged Feature Attributes):
              </label>
              <span className="text-[10px] text-slate-500 font-nepali">
                {Object.keys(attributes).length} फिल्डहरू (कुनै पनि मान परिमार्जन गर्न सकिन्छ)
              </span>
            </div>

            {/* Attribute Table */}
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1 scrollbar-thin">
              {Object.keys(attributes).length === 0 ? (
                <p className="text-slate-400 italic text-center py-3 text-[11px]">
                  कुनै विशेषताहरू छैनन्।
                </p>
              ) : (
                Object.entries(attributes).map(([k, v]) => (
                  <div
                    key={k}
                    className="flex items-center gap-2 p-1.5 bg-white rounded-lg border border-slate-200 hover:border-slate-300"
                  >
                    <span className="w-1/3 text-[11px] font-bold text-slate-700 truncate font-mono" title={k}>
                      {k}
                    </span>
                    <input
                      type="text"
                      value={v !== null && v !== undefined ? String(v) : ''}
                      onChange={(e) => handleAttrChange(k, e.target.value)}
                      className="flex-1 px-2 py-1 rounded border border-slate-200 text-xs focus:ring-1 focus:ring-violet-500 focus:border-violet-500 bg-slate-50/50 hover:bg-white"
                      placeholder="मान प्रविष्ट गर्नुहोस्"
                    />

                    {/* Helper: Pick value from other features if different */}
                    {features.some((f) => f.properties?.[k] !== undefined && String(f.properties[k]) !== String(v)) && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        {features.map((f, fIdx) => {
                          const fid = getFid(f);
                          const otherVal = f.properties?.[k];
                          if (otherVal === undefined || String(otherVal) === String(v)) return null;
                          return (
                            <button
                              key={fid || fIdx}
                              type="button"
                              onClick={() => handleTakeValueFromFeature(k, otherVal)}
                              className="px-1 py-0.5 rounded text-[8.5px] font-mono bg-violet-100 hover:bg-violet-200 text-violet-800 transition-colors cursor-pointer"
                              title={`फिचर #${fid || fIdx + 1} बाट मान (${otherVal}) लिने`}
                            >
                              F{fIdx + 1}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => handleRemoveAttr(k)}
                      className="p-1 text-slate-400 hover:text-red-600 rounded transition-colors cursor-pointer shrink-0"
                      title="फिल्ड हटाउनुहोस्"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Quick Add Custom Field Form */}
            <form onSubmit={handleAddField} className="flex items-center gap-1.5 pt-1 border-t border-slate-200">
              <input
                type="text"
                placeholder="नयाँ फिल्ड (Field Name)"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="w-1/3 px-2 py-1 rounded border border-slate-200 text-xs focus:ring-1 focus:ring-violet-500 font-mono"
              />
              <input
                type="text"
                placeholder="फिल्डको मान (Value)"
                value={newVal}
                onChange={(e) => setNewVal(e.target.value)}
                className="flex-1 px-2 py-1 rounded border border-slate-200 text-xs focus:ring-1 focus:ring-violet-500"
              />
              <button
                type="submit"
                disabled={!newKey.trim()}
                className="px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-800 disabled:bg-slate-300 text-white text-[11px] font-bold font-nepali transition-colors cursor-pointer shrink-0"
              >
                + थप्नुहोस्
              </button>
            </form>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-50 px-4 py-3 sm:px-5 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold font-nepali text-xs transition-colors cursor-pointer"
          >
            रद्द (Cancel)
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={saving}
            className="px-5 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-bold font-nepali text-xs shadow-md transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>एकीकरण सुरक्षित हुँदैछ…</span>
              </>
            ) : (
              <>
                <Combine className="w-4 h-4" />
                <span>{features.length} फिचरहरू एकीकरण गर्नुहोस् (Confirm Merge)</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

