import { coerceBodyToSchema, missingRequiredFields } from '../body-validator';

describe('coerceBodyToSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      qty: { type: 'integer' },
      price: { type: 'number' },
      active: { type: 'boolean' },
      name: { type: 'string' },
      cityId: { type: 'integer' },
      tags: { type: 'array', items: { type: 'integer' } },
      meta: { type: 'object', properties: { count: { type: 'number' } } },
    },
  };

  it('coerces numeric and boolean strings to their schema types', () => {
    const out = coerceBodyToSchema({ qty: '3', price: '9.99', active: 'true', name: 'widget' }, schema);
    expect(out).toEqual({ qty: 3, price: 9.99, active: true, name: 'widget' });
  });

  it('leaves {{placeholder}} values untouched even when schema wants a number', () => {
    const out = coerceBodyToSchema({ cityId: '{{city_id}}', qty: '2' }, schema);
    expect(out.cityId).toBe('{{city_id}}');
    expect(out.qty).toBe(2);
  });

  it('recurses arrays and nested objects', () => {
    const out = coerceBodyToSchema({ tags: ['1', '2'], meta: { count: '5' } }, schema);
    expect(out.tags).toEqual([1, 2]);
    expect(out.meta.count).toBe(5);
  });

  it('does not coerce non-numeric strings', () => {
    const out = coerceBodyToSchema({ qty: 'abc' }, schema);
    expect(out.qty).toBe('abc');
  });

  it('is a no-op without a schema', () => {
    expect(coerceBodyToSchema({ a: '1' }, undefined)).toEqual({ a: '1' });
  });
});

describe('missingRequiredFields', () => {
  const schema = { type: 'object', required: ['productId', 'qty'], properties: { productId: {}, qty: {}, note: {} } };

  it('lists required fields absent or null', () => {
    expect(missingRequiredFields({ qty: 1 }, schema)).toEqual(['productId']);
    expect(missingRequiredFields({ productId: 'p', qty: null }, schema)).toEqual(['qty']);
  });

  it('returns [] when all required fields are present', () => {
    expect(missingRequiredFields({ productId: 'p', qty: 1 }, schema)).toEqual([]);
  });

  it('returns [] when schema declares no required', () => {
    expect(missingRequiredFields({}, { type: 'object', properties: {} })).toEqual([]);
  });
});
