'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Key,
  X,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Search,
  Sparkles,
  Layers,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Hash,
  Database,
  ArrowRight,
} from 'lucide-react';
import { layersAPI } from '../lib/api';

/**
 * PrimaryKeyConfigModal
 * Allows admins to designate a primary key / unique ID field on vector layer upload or layer management.
 * If values are empty, null, or duplicate, auto-generates unique IDs dynamically and reports an audit log.
 */
export default function PrimaryKeyConfigModal({
  isOpen,
  onClose,
  layer,
  isPostUpload = false,
  onSuccess,
}) {
  const [selectedField, setSelectedField] = useState('');
  const [customFieldName, setCustomFieldName] = useState('');
  const [isCustomField, setIsCustomField] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [autogenMissing, setAutogenMissing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Audit Results
  const [auditResult, setAuditResult] = useState(null);
  const [auditSearch, setAuditSearch] = useState('');
  const [auditFilterReason, setAuditFilterReason] = useState('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;

  // Extract available fields from layer
  const availableFields = useMemo(() => {
    if (!layer) return [];
    const fields = Array.isArray(layer.fields_config) ? layer.fields_config : [];
    const list = fields
      .map((f) => f.name || f)
      .filter((name) => name && !String(name).startsWith('_') && !['geom', 'the_geom', 'geometry'].includes(name));
    return Array.from(new Set(list));
  }, [layer]);

  // Initialize defaults on layer change
  useEffect(() => {
    if (layer) {
      setAuditResult(null);
      setErrorMsg('');
      setCurrentPage(1);

      // Default field recommendation
      const existingPk = layer.unique_field || layer.primary_key_field;
      if (existingPk) {
        setSelectedField(existingPk);
        setIsCustomField(false);
      } else if (availableFields.includes('building_code')) {
        setSelectedField('building_code');
        setIsCustomField(false);
      } else if (availableFields.includes('road_code')) {
        setSelectedField('road_code');
        setIsCustomField(false);
      } else if (availableFields.includes('id')) {
        setSelectedField('id');
        setIsCustomField(false);
      } else if (availableFields.includes('gid')) {
        setSelectedField('gid');
        setIsCustomField(false);
      } else if (availableFields.length > 0) {
        setSelectedField(availableFields[0]);
        setIsCustomField(false);
      } else {
        setSelectedField('__custom__');
        setIsCustomField(true);
        setCustomFieldName('feature_uid');
      }

      // Default prefix
      const lName = (layer.name || 'FEAT').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const prefixCandidate = `KMC-${lName.slice(0, 4) || 'FEAT'}-`;
      setPrefix(layer.unique_prefix || prefixCandidate);
    }
  }, [layer, availableFields]);

  if (!isOpen || !layer) return null;

  const handleFieldChange = (e) => {
    const val = e.target.value;
    if (val === '__custom__') {
      setIsCustomField(true);
      setSelectedField('__custom__');
      if (!customFieldName) setCustomFieldName('feature_uid');
    } else {
      setIsCustomField(false);
      setSelectedField(val);
    }
  };

  const handleApplyPrimaryKey = async (e) => {
    if (e) e.preventDefault();
    const targetField = isCustomField ? customFieldName.trim() : selectedField.trim();
    if (!targetField) {
      setErrorMsg('कृपया प्राथमिक कुञ्जी (Primary Key) फिल्ड चयन वा प्रविष्ट गर्नुहोस्');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    try {
      const res = await layersAPI.setPrimaryKey(layer.id, {
        primary_key_field: targetField,
        prefix: prefix.trim(),
        autogenerate_missing: autogenMissing,
      });

      setAuditResult(res.data);
      if (onSuccess) onSuccess(res.data);
    } catch (err) {
      console.error('Failed to set primary key:', err);
      setErrorMsg(err.response?.data?.detail || err.message || 'प्राथमिक कुञ्जी सुरक्षित गर्न सकिएन');
    } finally {
      setLoading(false);
    }
  };

  // Filtered audit records for table
  const filteredAuditRecords = useMemo(() => {
    if (!auditResult || !Array.isArray(auditResult.all_audit_records)) return [];
    let list = auditResult.all_audit_records;

    if (auditFilterReason === 'EMPTY') {
      list = list.filter((r) => String(r.reason).includes('Empty') || String(r.reason).includes('खाली'));
    } else if (auditFilterReason === 'DUPLICATE') {
      list = list.filter((r) => String(r.reason).includes('Duplicate') || String(r.reason).includes('दोहोरिएको'));
    }

    if (auditSearch.trim()) {
      const q = auditSearch.trim().toLowerCase();
      list = list.filter(
        (r) =>
          String(r.feature_id).toLowerCase().includes(q) ||
          String(r.old_value).toLowerCase().includes(q) ||
          String(r.generated_value).toLowerCase().includes(q)
      );
    }

    return list;
  }, [auditResult, auditFilterReason, auditSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredAuditRecords.length / pageSize));
  const pagedRecords = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredAuditRecords.slice(start, start + pageSize);
  }, [filteredAuditRecords, currentPage]);

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 font-sans animate-fade-in">
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92dvh] overflow-hidden flex flex-col animate-scale-up"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-gov-blue-800 to-sky-900 text-white p-4 sm:px-6 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-xs border border-white/30 flex items-center justify-center shrink-0 shadow-inner">
              <Key className="w-5 h-5 text-amber-300" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider bg-white/20 px-2 py-0.5 rounded text-sky-100">
                  {isPostUpload ? 'नयाँ तह अपलोड पश्चात प्रमाणीकरण' : 'तह अद्वितीयता व्यवस्थापन'}
                </span>
                <span className="text-[10px] text-sky-200 font-mono">
                  #{layer.id}
                </span>
              </div>
              <h2 className="text-sm sm:text-base font-bold font-nepali text-white truncate leading-snug">
                प्राथमिक कुञ्जी तथा अद्वितीय पहिचान (Primary Key / Unique ID)
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
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5 text-xs scrollbar-thin">
          {/* Target Layer Summary Card */}
          <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-gov-blue-100 text-gov-blue-800 flex items-center justify-center shrink-0">
                <Layers className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-slate-900 truncate font-nepali">
                  {layer.name || layer.filename || 'भेक्टर तह'}
                </p>
                <p className="text-[10px] text-slate-500 font-nepali flex items-center gap-2">
                  <span>ज्यामिति: {layer.geometry_type || 'Polygon'}</span>
                  <span>•</span>
                  <span>कुल फिचरहरू: <strong>{(layer.feature_count || 0).toLocaleString()}</strong></span>
                </p>
              </div>
            </div>
            {layer.unique_field && (
              <div className="shrink-0 bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold px-2 py-1 rounded-md font-mono">
                PK: {layer.unique_field}
              </div>
            )}
          </div>

          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-800 flex items-center gap-2 text-xs font-nepali">
              <ShieldAlert className="w-4 h-4 shrink-0 text-red-600" />
              <span>{errorMsg}</span>
            </div>
          )}

          {!auditResult ? (
            /* Mode 1: Configuration Form */
            <form onSubmit={handleApplyPrimaryKey} className="space-y-4">
              <div className="bg-sky-50/70 border border-sky-200 rounded-xl p-3 text-[11px] font-nepali text-sky-950 leading-relaxed">
                <p className="font-bold flex items-center gap-1.5 text-gov-blue-900 mb-1">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  अद्वितीय प्राथमिक कुञ्जी (Primary Key) को महत्त्व:
                </p>
                प्रत्येक फिचरको छुट्टै पहिचान (Unique Identifier) हुनु अनिवार्य छ। यदि छानिएको फिल्डमा कुनै फिचरको मान खाली, नल वा दोहोरिएको छ भने, प्रणालीले स्वचालित रूपमा नयाँ अद्वितीय कोड सिर्जना गरी अडिट विवरण प्रस्तुत गर्नेछ।
              </div>

              {/* Field Selection */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-gov-blue-700" />
                  प्राथमिक कुञ्जी फिल्ड छान्नुहोस् (Primary Key Field):
                </label>
                <select
                  value={isCustomField ? '__custom__' : selectedField}
                  onChange={handleFieldChange}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 font-mono text-xs focus:ring-2 focus:ring-gov-blue-500 focus:outline-hidden"
                >
                  {availableFields.map((fName) => (
                    <option key={fName} value={fName}>
                      {fName} {fName === layer.unique_field ? '(हालको प्राथमिक कुञ्जी)' : ''}
                    </option>
                  ))}
                  <option value="__custom__">+ नयाँ अद्वितीय फिल्ड सिर्जना गर्नुहोस् (New Custom Field)...</option>
                </select>
              </div>

              {/* Custom field name input */}
              {isCustomField && (
                <div className="space-y-1.5 animate-fade-in pl-1">
                  <label className="text-[11px] font-bold text-slate-700 font-nepali">
                    नयाँ फिल्डको नाम (New Field Name):
                  </label>
                  <input
                    type="text"
                    value={customFieldName}
                    onChange={(e) => setCustomFieldName(e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'))}
                    placeholder="e.g. building_code वा parcel_uid"
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 font-mono text-xs focus:ring-2 focus:ring-gov-blue-500 focus:outline-hidden"
                  />
                </div>
              )}

              {/* Prefix Setting */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-gov-blue-700" />
                  स्वतः उत्पादनका लागि उपसर्ग (ID Prefix):
                </label>
                <input
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                  placeholder="e.g. KMC-BLD- वा KMC-ROAD-"
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 font-mono text-xs focus:ring-2 focus:ring-gov-blue-500 focus:outline-hidden"
                />
                <p className="text-[10px] text-slate-500 font-nepali">
                  खाली वा दोहोरिएका मानहरूको स्थानमा {prefix}00001, {prefix}00002 जस्ता अद्वितीय कोडहरू बन्नेछन्।
                </p>
              </div>

              {/* Autogenerate Checkbox */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50/70 border border-amber-200 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autogenMissing}
                  onChange={(e) => setAutogenMissing(e.target.checked)}
                  className="mt-0.5 rounded text-gov-blue-700 focus:ring-gov-blue-500"
                />
                <div className="text-[11px] font-nepali text-slate-800">
                  <span className="font-bold text-amber-950">
                    रिक्त, नल तथा दोहोरिएका मानहरू स्वतः अद्वितीय बनाउनुहोस् (Auto-generate Missing & Duplicate IDs)
                  </span>
                  <p className="text-[10px] text-slate-600 mt-0.5">
                    कुनै पनि फिचर नछुटाई सम्पूर्ण तहलाई उच्च गति र गुणस्तरीय प्रणालीमा प्रमाणीकरण गर्न सिफारिस गरिन्छ।
                  </p>
                </div>
              </label>

              {/* Submit Button */}
              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl text-slate-700 bg-slate-100 hover:bg-slate-200 font-bold font-nepali transition-colors cursor-pointer"
                >
                  पछि गर्ने (Skip / Cancel)
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 rounded-xl text-white bg-gov-blue-800 hover:bg-gov-blue-900 disabled:opacity-50 font-bold font-nepali flex items-center gap-2 shadow-md transition-all cursor-pointer"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>प्रमाणीकरण तथा उत्पादन हुँदैछ...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-300" />
                      <span>प्राथमिक कुञ्जी लागू गर्नुहोस्</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            /* Mode 2: Audit Report & Searchable Generated Records */
            <div className="space-y-4 animate-fade-in">
              {/* Success Result Banner */}
              <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-950 flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-bold text-xs sm:text-sm font-nepali">
                    प्राथमिक कुञ्जी (Primary Key) सफलतापूर्वक लागू भयो!
                  </h3>
                  <p className="text-[11px] text-emerald-800 font-nepali">
                    फिल्ड: <strong className="font-mono">{auditResult.primary_key_field}</strong> (उपसर्ग: <strong className="font-mono">{auditResult.prefix}</strong>)
                  </p>
                </div>
              </div>

              {/* 3 Metric Summary Cards */}
              <div className="grid grid-cols-3 gap-2 sm:gap-3 text-center">
                <div className="p-2.5 sm:p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-nepali">कुल फिचरहरू</p>
                  <p className="text-base sm:text-lg font-bold text-slate-900 font-mono mt-0.5">
                    {(auditResult.total_features || 0).toLocaleString()}
                  </p>
                </div>
                <div className="p-2.5 sm:p-3 rounded-xl bg-emerald-50 border border-emerald-200">
                  <p className="text-[10px] text-emerald-700 font-nepali">पहिले नै अद्वितीय</p>
                  <p className="text-base sm:text-lg font-bold text-emerald-900 font-mono mt-0.5">
                    {Math.max(0, (auditResult.total_features || 0) - (auditResult.total_autogenerated || 0)).toLocaleString()}
                  </p>
                </div>
                <div className={`p-2.5 sm:p-3 rounded-xl border ${auditResult.total_autogenerated > 0 ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
                  <p className="text-[10px] text-amber-800 font-nepali font-semibold">स्वतः उत्पादन गरिएका</p>
                  <p className="text-base sm:text-lg font-bold text-amber-950 font-mono mt-0.5">
                    {(auditResult.total_autogenerated || 0).toLocaleString()}
                  </p>
                </div>
              </div>

              {auditResult.total_autogenerated > 0 ? (
                <div className="space-y-2.5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <label className="text-[11px] font-bold text-slate-800 font-nepali flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                      उत्पादन गरिएका अद्वितीय पहिचान विवरण ({filteredAuditRecords.length} फिचर):
                    </label>

                    {/* Filter Pills */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => { setAuditFilterReason('ALL'); setCurrentPage(1); }}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold font-nepali transition-colors cursor-pointer ${auditFilterReason === 'ALL' ? 'bg-gov-blue-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                      >
                        सबै
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAuditFilterReason('EMPTY'); setCurrentPage(1); }}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold font-nepali transition-colors cursor-pointer ${auditFilterReason === 'EMPTY' ? 'bg-amber-700 text-white' : 'bg-amber-50 text-amber-800 hover:bg-amber-100'}`}
                      >
                        खाली/Null
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAuditFilterReason('DUPLICATE'); setCurrentPage(1); }}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold font-nepali transition-colors cursor-pointer ${auditFilterReason === 'DUPLICATE' ? 'bg-purple-700 text-white' : 'bg-purple-50 text-purple-800 hover:bg-purple-100'}`}
                      >
                        दोहोरिएको
                      </button>
                    </div>
                  </div>

                  {/* Search Input */}
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={auditSearch}
                      onChange={(e) => { setAuditSearch(e.target.value); setCurrentPage(1); }}
                      placeholder="पुरानो मान, नयाँ ID वा फिचर नम्बर खोज्नुहोस्..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-gov-blue-500 font-nepali"
                    />
                  </div>

                  {/* Paginated Audit Table */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    <div className="max-h-56 overflow-y-auto scrollbar-thin">
                      <table className="w-full text-left text-[11px]">
                        <thead className="bg-slate-100 text-slate-700 font-bold font-nepali sticky top-0 border-b border-slate-200">
                          <tr>
                            <th className="py-2 px-3"># फिचर</th>
                            <th className="py-2 px-3">पुरानो मान (Old)</th>
                            <th className="py-2 px-3">नयाँ अद्वितीय कुञ्जी (New)</th>
                            <th className="py-2 px-3">कारण</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {pagedRecords.length > 0 ? (
                            pagedRecords.map((item, idx) => (
                              <tr key={item.id || idx} className="hover:bg-sky-50/50 transition-colors">
                                <td className="py-1.5 px-3 text-slate-500">#{item.feature_id || item.id}</td>
                                <td className="py-1.5 px-3 text-slate-400 truncate max-w-[120px]">{String(item.old_value)}</td>
                                <td className="py-1.5 px-3 font-bold text-emerald-800 flex items-center gap-1">
                                  <span>{item.generated_value}</span>
                                </td>
                                <td className="py-1.5 px-3 text-[10px] font-nepali">
                                  <span className={`px-1.5 py-0.5 rounded font-bold ${String(item.reason).includes('Duplicate') || String(item.reason).includes('दोहोरिएको') ? 'bg-purple-100 text-purple-800' : 'bg-amber-100 text-amber-800'}`}>
                                    {item.reason}
                                  </span>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={4} className="py-4 text-center text-slate-400 font-nepali">
                                कुनै रेकर्ड फेला परेन
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination Bar */}
                    {totalPages > 1 && (
                      <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center justify-between text-[10px] font-nepali text-slate-600">
                        <span>
                          पृष्ठ {currentPage} / {totalPages} (जम्मा {filteredAuditRecords.length})
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={currentPage <= 1}
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 cursor-pointer"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={currentPage >= totalPages}
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 cursor-pointer"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-center text-slate-600 font-nepali text-xs">
                  👏 सबै फिचरहरूमा पहिले नै अद्वितीय प्राथमिक कुञ्जी मान विद्यमान छन्। कुनै पनि मान स्वतः उत्पादन गर्नुपरेन।
                </div>
              )}

              {/* Close / Done Button */}
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-6 py-2 rounded-xl text-white bg-gov-blue-800 hover:bg-gov-blue-900 font-bold font-nepali shadow-md transition-colors cursor-pointer"
                >
                  सम्पन्न भयो (Done)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
