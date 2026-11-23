'use client';

import { useState } from 'react';
import {
  Layers,
  X,
  Plus,
  Loader2,
  FolderKanban,
  Globe2,
  Circle,
  Minus,
  Triangle,
  Sparkles,
  Palette,
  Check,
  Magnet,
} from 'lucide-react';
import { layersAPI } from '../lib/api';
import { formatApiError } from '../lib/apiError';

const PRESET_COLORS = [
  { name: 'Gov Blue', hex: '#0447AF' },
  { name: 'Gov Red', hex: '#DC2626' },
  { name: 'Emerald', hex: '#059669' },
  { name: 'Amber', hex: '#D97706' },
  { name: 'Purple', hex: '#7C3AED' },
  { name: 'Teal', hex: '#0D9488' },
  { name: 'Indigo', hex: '#4338CA' },
  { name: 'Slate', hex: '#334155' },
];

export default function CreateLayerModal({
  isOpen,
  onClose,
  projects = [],
  activeProjectId = null,
  onLayerCreated,
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [geometryType, setGeometryType] = useState('Polygon'); // 'Point' | 'LineString' | 'Polygon' | 'Mix'
  const [scope, setScope] = useState(activeProjectId ? 'project' : 'global'); // 'global' | 'project'
  const [selectedProjectId, setSelectedProjectId] = useState(activeProjectId || (projects[0]?.id || ''));
  const [selectedColor, setSelectedColor] = useState('#0447AF');
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [allowSnapping, setAllowSnapping] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('कृपया तहको नाम प्रविष्ट गर्नुहोस्।');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const isGlobal = scope === 'global';
      const creationGeoms =
        geometryType === 'Mix'
          ? ['Point', 'LineString', 'Polygon']
          : [geometryType];

      const payload = {
        name: name.trim(),
        description: description.trim(),
        geometry_type: geometryType,
        creation_geometry_types: creationGeoms,
        is_global: isGlobal,
        project_id: isGlobal ? null : (selectedProjectId ? Number(selectedProjectId) : null),
        allow_snapping: allowSnapping,
        style: {
          strokeColor: selectedColor,
          fillColor: selectedColor,
          strokeWidth: Number(strokeWidth),
          clickTolerance: 14,
        },
      };

      const res = await layersAPI.create(payload);
      const created = res?.data || res;
      if (onLayerCreated) onLayerCreated(created);
      onClose();
    } catch (err) {
      console.error('Error creating layer:', err);
      setError(formatApiError(err, 'तह सिर्जना गर्दा त्रुटि भयो।'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-fade-in font-sans">
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg max-h-[92dvh] overflow-hidden flex flex-col animate-scale-up"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-gov-blue-800 to-indigo-900 text-white p-4 sm:px-5 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-xs border border-white/30 flex items-center justify-center shrink-0 shadow-inner">
              <Plus className="w-5 h-5 text-gov-gold-300" />
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.2 rounded text-gov-blue-100">
                काठमाडौँ महानगरपालिका GIS तह व्यवस्थापन
              </span>
              <h2 className="text-sm sm:text-base font-bold font-nepali text-white truncate leading-snug">
                नयाँ भेक्टर तह सिर्जना गर्नुहोस् (Create New Layer)
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

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 text-xs scrollbar-thin">
          {error && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-nepali font-semibold">
              {error}
            </div>
          )}

          {/* Layer Name */}
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1">
              <span>तहको नाम (Layer Name)</span>
              <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="उदाहरण: ढल निकास नेटवर्क / खानेपानी पाइप"
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-nepali focus:ring-2 focus:ring-gov-blue-500 focus:border-gov-blue-500 bg-white"
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-800 font-nepali">
              विवरण (Description - ऐच्छिक)
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="तह सम्बन्धी संक्षिप्त विवरण..."
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-nepali focus:ring-2 focus:ring-gov-blue-500 focus:border-gov-blue-500 bg-white resize-none"
            />
          </div>

          {/* Geometry Type Selection */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-800 font-nepali">
              ज्यामिति प्रकार (Geometry Type):
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { type: 'Point', label: 'Point', nepali: 'बिन्दु', icon: Circle },
                { type: 'LineString', label: 'Line', nepali: 'रेखा', icon: Minus },
                { type: 'Polygon', label: 'Polygon', nepali: 'बहुभुज', icon: Triangle },
                { type: 'Mix', label: 'Mix', nepali: 'मिश्रित', icon: Sparkles },
              ].map((item) => {
                const Icon = item.icon;
                const isSelected = geometryType === item.type;
                return (
                  <button
                    key={item.type}
                    type="button"
                    onClick={() => setGeometryType(item.type)}
                    className={`p-2.5 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-gov-blue-50 border-gov-blue-600 ring-2 ring-gov-blue-400 text-gov-blue-900 shadow-xs'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="font-bold text-[11px] font-nepali">{item.nepali}</span>
                    <span className="text-[9px] text-slate-500 font-mono">({item.label})</span>
                  </button>
                );
              })}
            </div>
            {geometryType === 'Mix' && (
              <span className="text-[10px] text-gov-blue-700 bg-gov-blue-50 p-2 rounded-lg border border-gov-blue-200 block font-nepali">
                मिश्रित (Mix) तहमा प्रयोगकर्ताले बिन्दु (Point), रेखा (LineString), र बहुभुज (Polygon) जुनसुकै फिचरहरू संकलन तथा सम्पादन गर्न सक्नेछन्।
              </span>
            )}
          </div>

          {/* Scope: Global vs Project-Specific */}
          <div className="space-y-1.5 bg-slate-50 p-3 rounded-xl border border-slate-200">
            <label className="text-[11px] font-bold text-slate-800 font-nepali">
              दायरा / स्कोप (Layer Scope):
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`p-2.5 rounded-xl border flex items-start gap-2 cursor-pointer transition-all ${
                  scope === 'global'
                    ? 'bg-white border-gov-blue-600 ring-1 ring-gov-blue-400 shadow-xs'
                    : 'bg-white/60 border-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="layer_scope"
                  checked={scope === 'global'}
                  onChange={() => setScope('global')}
                  className="mt-0.5 text-gov-blue-800 focus:ring-gov-blue-500"
                />
                <div>
                  <span className="font-bold text-[11px] font-nepali text-slate-800 block flex items-center gap-1">
                    <Globe2 className="w-3 h-3 text-purple-700" />
                    समग्र महानगर (Global)
                  </span>
                  <span className="text-[9.5px] text-slate-500 font-nepali block mt-0.5">
                    काठमाडौँका सबै परियोजना तथा ड्यासबोर्डमा देखिने
                  </span>
                </div>
              </label>

              <label
                className={`p-2.5 rounded-xl border flex items-start gap-2 cursor-pointer transition-all ${
                  scope === 'project'
                    ? 'bg-white border-gov-blue-600 ring-1 ring-gov-blue-400 shadow-xs'
                    : 'bg-white/60 border-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="layer_scope"
                  checked={scope === 'project'}
                  onChange={() => setScope('project')}
                  className="mt-0.5 text-gov-blue-800 focus:ring-gov-blue-500"
                />
                <div>
                  <span className="font-bold text-[11px] font-nepali text-slate-800 block flex items-center gap-1">
                    <FolderKanban className="w-3 h-3 text-amber-700" />
                    विशिष्ट परियोजना (Project)
                  </span>
                  <span className="text-[9.5px] text-slate-500 font-nepali block mt-0.5">
                    तोकिएको परियोजनामा मात्र सीमित रहने
                  </span>
                </div>
              </label>
            </div>

            {scope === 'project' && (
              <div className="pt-2">
                <label className="text-[10px] font-bold text-slate-600 mb-1 block font-nepali">
                  परियोजना छान्नुहोस्:
                </label>
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-nepali text-xs bg-white focus:ring-1 focus:ring-gov-blue-500"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Color & Styling */}
          <div className="space-y-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-gov-blue-800" />
                तहको रङ्ग तथा शैली (Layer Style):
              </label>
              <div
                className="w-5 h-5 rounded-md border border-slate-300 shadow-inner"
                style={{ backgroundColor: selectedColor }}
              />
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => setSelectedColor(c.hex)}
                  className={`w-7 h-7 rounded-lg border flex items-center justify-center transition-all cursor-pointer ${
                    selectedColor === c.hex ? 'ring-2 ring-gov-blue-600 border-white scale-110 shadow-xs' : 'border-slate-300 hover:scale-105'
                  }`}
                  style={{ backgroundColor: c.hex }}
                  title={c.name}
                >
                  {selectedColor === c.hex && <Check className="w-3.5 h-3.5 text-white" />}
                </button>
              ))}
              <input
                type="color"
                value={selectedColor}
                onChange={(e) => setSelectedColor(e.target.value)}
                className="w-7 h-7 rounded-lg border border-slate-300 p-0.5 cursor-pointer bg-white"
                title="कस्टम रङ्ग छान्नुहोस्"
              />
            </div>

            <div className="flex items-center justify-between pt-1 text-[10px] text-slate-600 font-nepali">
              <span>सिमानाको मोटाइ (Stroke Width):</span>
              <div className="flex items-center gap-2 font-mono">
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="0.5"
                  value={strokeWidth}
                  onChange={(e) => setStrokeWidth(e.target.value)}
                  className="w-24 accent-gov-blue-800"
                />
                <span>{strokeWidth}px</span>
              </div>
            </div>
          </div>

          {/* Snapping */}
          <label className="flex items-center gap-2 p-2 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={allowSnapping}
              onChange={(e) => setAllowSnapping(e.target.checked)}
              className="text-gov-blue-800 rounded focus:ring-gov-blue-500"
            />
            <div className="min-w-0">
              <span className="font-bold text-[11px] font-nepali text-slate-800 flex items-center gap-1">
                <Magnet className="w-3 h-3 text-emerald-600" />
                स्न्यापिङ अनुमति दिने (Allow Geometric Snapping)
              </span>
              <span className="text-[9.5px] text-slate-500 font-nepali block">
                सम्पादन तथा अङ्कनको क्रममा बिन्दु र सिमानाहरूमा स्न्याप गर्न दिइनेछ।
              </span>
            </div>
          </label>
        </form>

        {/* Footer Actions */}
        <div className="bg-slate-50 px-4 py-3 sm:px-5 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold font-nepali text-xs transition-colors cursor-pointer"
          >
            रद्द (Cancel)
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={creating || !name.trim()}
            className="px-5 py-2 rounded-xl bg-gov-blue-800 hover:bg-gov-blue-900 text-white font-bold font-nepali text-xs shadow-md transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {creating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>तह सिर्जना हुँदैछ…</span>
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                <span>तह सिर्जना गर्नुहोस् (Create Layer)</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

