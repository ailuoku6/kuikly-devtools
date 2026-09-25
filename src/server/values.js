'use strict';

const own = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
const isColorKey = (key) => /color|tint/i.test(key);

// Kuikly uses ARGB, including for #AARRGGBB (not CSS #RRGGBBAA).
function colorBits(value) {
  let n = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^0x[\da-f]{1,8}$/i.test(text)) n = Number(text);
    else if (/^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(text)) {
      n = parseInt(text.length === 7 ? `FF${text.slice(1)}` : text.slice(1), 16);
    } else if (/^-?\d+$/.test(text)) n = Number(text);
    else return null;
  }
  if (typeof n !== 'number' || !Number.isInteger(n) || n < -2147483648 || n > 4294967295) return null;
  return n >>> 0;
}

function displayValue(value, key = '', type = '') {
  if (isColorKey(key) || type === 'Color' || type === 'Color?') {
    const bits = colorBits(value);
    if (bits !== null) return `0x${bits.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  if (Array.isArray(value)) return value.map((item) => displayValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displayValue(v, k)]));
  }
  return value;
}

function normalizeNode(node) {
  const result = { ...node };
  for (const target of ['p', 's', 'as']) {
    if (node[target]) result[target] = Object.fromEntries(Object.entries(node[target])
      .map(([key, value]) => [key, displayValue(value, key, node.e?.[target]?.[key])]));
  }
  return result;
}

function prepareEdit(node, command) {
  if (command.mode) throw new Error('Unsupported edit mode');
  const { target, key, requestId } = command;
  if (!node || !['p', 's', 'as'].includes(target) || typeof key !== 'string' ||
      typeof requestId !== 'string' || !requestId || requestId.length > 128 || !own(command, 'value')) {
    throw new Error('Invalid edit command or missing node');
  }
  if (!own(node.e?.[target], key)) throw new Error('Field is read-only; rebuild the page with the latest instrumentor');
  const declaredType = node.e[target][key];
  const nullable = declaredType.endsWith('?');
  const type = nullable ? declaredType.slice(0, -1) : declaredType;
  let value = command.value;
  if (value === null) {
    if (!nullable) throw new Error('This field is not nullable');
  } else {
    const color = type === 'Color' || (isColorKey(key) && ['String', 'Int', 'Long'].includes(type));
    if (color) {
      const bits = colorBits(value);
      if (bits === null) {
        // Native color tokens remain valid string/Color values.
        if (!['String', 'Color'].includes(type) || typeof value !== 'string' ||
            /^(?:#|0x|[+-]?\d)/i.test(value.trim()) || !value.trim()) throw new Error('Invalid ARGB color');
      } else {
        value = type === 'String' ? String(bits) : type === 'Int' ? bits | 0 : bits;
      }
    }
    if (type === 'Boolean' && typeof value !== 'boolean') throw new Error('Expected a boolean');
    if (type === 'String' && typeof value !== 'string') throw new Error('Expected a string');
    if (type === 'Char' && (typeof value !== 'string' || value.length !== 1)) throw new Error('Expected one character');
    if (['Byte', 'Short', 'Int', 'Long', 'Float', 'Double'].includes(type)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite number');
      const bounds = { Byte: [-128, 127], Short: [-32768, 32767], Int: [-2147483648, 2147483647], Long: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };
      if (bounds[type] && (!Number.isSafeInteger(value) || value < bounds[type][0] || value > bounds[type][1])) throw new Error(`Out of range for ${type}`);
      if (type === 'Float' && !Number.isFinite(Math.fround(value))) throw new Error('Out of range for Float');
    }
    if (type.startsWith('enum:') && !type.slice(5).split(',').includes(value)) throw new Error('Invalid enum value');
    if (type === 'space') {
      const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Number.isFinite(Math.fround(v));
      if (!finite(value) && !(value && typeof value === 'object' && !Array.isArray(value) &&
          Object.entries(value).every(([k, v]) => ['top', 'left', 'bottom', 'right'].includes(k) && finite(v)))) throw new Error('Expected a number or an object with top/left/bottom/right');
    }
  }
  return { type: 'edit', id: node.id, target, key, value, requestId };
}

module.exports = { colorBits, normalizeNode, prepareEdit };

/** New semantic edits use device-authored schema, never infer types from an absent old value. */
function prepareSupportedEdit(node, command, schema) {
  const { id, key, requestId, target, schemaToken } = command;
  if (!node || target !== 'p' || typeof key !== 'string' || typeof requestId !== 'string' ||
      !requestId || requestId.length > 128 || !own(command, 'value')) throw new Error('Invalid supported-property edit or missing node');
  if (!schema || schema.schemaVersion !== 1 || schema.schemaToken !== schemaToken || schema.id !== id) {
    throw new Error('SCHEMA_EXPIRED: query inspect props again before editing');
  }
  const def = schema.properties.find((item) => item.key === key);
  if (!def) throw new Error('UNSUPPORTED_PROPERTY: node does not support this property');
  let value = command.value;
  const number = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isFinite(Math.fround(v)) ||
        (def.min !== undefined && (def.exclusiveMin ? v <= def.min : v < def.min)) ||
        (def.max !== undefined && v > def.max)) throw new Error(`INVALID_VALUE: ${def.description}`);
  };
  switch (def.inputType) {
    case 'color':
      value = colorBits(value);
      if (value === null) throw new Error('INVALID_VALUE: expected numeric ARGB; theme tokens are not supported');
      break;
    case 'boolean': if (typeof value !== 'boolean') throw new Error('INVALID_VALUE: expected true or false'); break;
    case 'string': if (typeof value !== 'string' || value.length > 2000) throw new Error('INVALID_VALUE: expected text up to 2000 characters'); break;
    case 'enum': if (!def.enumValues?.includes(value)) throw new Error(`INVALID_VALUE: ${def.description}`); break;
    case 'number': number(value); break;
    case 'space':
      if (typeof value === 'number') number(value);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [side, n] of Object.entries(value)) {
          if (!['top', 'left', 'bottom', 'right'].includes(side)) throw new Error('INVALID_VALUE: unknown spacing side');
          number(n);
        }
      } else throw new Error('INVALID_VALUE: expected spacing number or object');
      break;
    default: throw new Error('Unsupported property schema type');
  }
  return { type: 'edit', mode: 'setSupported', id, target, key, requestId, schemaToken, value };
}

function normalizeSchema(result) {
  return { ...result, properties: result.properties?.map((def) => ({ ...def,
    ...(own(def, 'currentValue') ? { currentValue: displayValue(def.currentValue, def.key, def.inputType === 'color' ? 'Color' : '') } : {}),
  })) };
}
function normalizeEditResult(result) {
  if (!result.readback) return result;
  const rb = result.readback;
  return { ...result, readback: { ...rb, ...(own(rb, 'value') ? {
    value: displayValue(rb.value, rb.key, rb.inputType === 'color' ? 'Color' : ''),
  } : {}) } };
}
module.exports.prepareSupportedEdit = prepareSupportedEdit;
module.exports.normalizeSchema = normalizeSchema;
module.exports.normalizeEditResult = normalizeEditResult;
