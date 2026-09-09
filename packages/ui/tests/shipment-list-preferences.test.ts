import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIPMENT_LIST_PREFERENCES as defaults, normalizeShipmentListPreferences as normalize, moveShipmentColumn as move } from '../../lib/shipment-list-preferences';
describe('shipment list preferences', () => {
  it('restores defaults for unavailable storage', () => expect(normalize(null)).toEqual(defaults));
  it('repairs stale columns and keeps the order reference visible', () => {
    const result = normalize({ columns: ['status', 'removed', 'status'], hidden: ['reference', 'date', 'removed', 'date'], sort: 'invalid' });
    expect(result.columns.slice(0, 2)).toEqual(['reference', 'status']);
    expect(new Set(result.columns).size).toBe(defaults.columns.length);
    expect(result.hidden).toEqual(['date']);
    expect(result.sort).toBe('');
  });
  it('preserves valid choices', () => expect(normalize({ ...defaults, density: 'comfortable', sort: '-recipient' })).toMatchObject({ density: 'comfortable', sort: '-recipient' }));
  it('moves a column in either direction without losing columns', () => {
    expect(move(['reference', 'date', 'status'], 'date', 'status')).toEqual(['reference', 'status', 'date']);
    expect(move(['reference', 'date', 'status'], 'status', 'date')).toEqual(['reference', 'status', 'date']);
    expect(move(defaults.columns, 'reference', 'date')).toEqual(defaults.columns);
  });
});
