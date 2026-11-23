import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatApiError } from './apiError.js';

const responseError = (data) => ({ response: { data }, message: 'Request failed with status code 422' });

describe('formatApiError', () => {
  it('returns a plain string detail unchanged', () => {
    assert.equal(formatApiError(responseError({ detail: 'भेक्टर तह भेटिएन।' })), 'भेक्टर तह भेटिएन।');
  });

  it('renders FastAPI validation arrays instead of [object Object]', () => {
    const message = formatApiError(
      responseError({
        detail: [
          { loc: ['path', 'project_id'], msg: 'Input should be a valid integer', type: 'int_parsing' },
          { loc: ['body', 'geometry'], msg: 'Field required', type: 'missing' },
        ],
      })
    );
    assert.equal(message, 'project_id: Input should be a valid integer; geometry: Field required');
    assert.ok(!message.includes('[object Object]'));
  });

  it('falls back to the axios message when the body has no detail', () => {
    assert.equal(formatApiError(responseError({}), 'fallback'), 'Request failed with status code 422');
  });

  it('uses the fallback for empty errors', () => {
    assert.equal(formatApiError(null, 'fallback'), 'fallback');
  });

  it('stringifies non-standard object details', () => {
    assert.equal(formatApiError(responseError({ detail: { msg: 'Nested failure' } })), 'Nested failure');
  });
});
