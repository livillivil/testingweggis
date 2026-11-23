/**
 * Turns an axios/FastAPI error into readable text.
 *
 * FastAPI validation errors put an array of objects in `detail`, and rendering
 * that array directly prints "[object Object]" to the user.
 */
export function formatApiError(error, fallback = 'कार्य पूरा गर्न सकिएन। (The request failed.)') {
  const detail = error?.response?.data?.detail ?? error?.response?.data?.message;

  if (typeof detail === 'string' && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const location = Array.isArray(item.loc)
            ? item.loc.filter((part) => part !== 'body' && part !== 'query' && part !== 'path').join('.')
            : '';
          const message = item.msg || item.message || 'Invalid value';
          return location ? `${location}: ${message}` : message;
        }
        return String(item);
      })
      .map((part) => String(part).trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join('; ');
  }

  if (detail && typeof detail === 'object') {
    if (typeof detail.msg === 'string' && detail.msg.trim()) return detail.msg;
    try {
      return JSON.stringify(detail);
    } catch {
      // fall through to the generic message
    }
  }

  return error?.message || fallback;
}
