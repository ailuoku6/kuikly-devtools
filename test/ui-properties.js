'use strict';
// Exercise the actual component event handlers and hook state without a browser/server.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const esbuild = require('../ui/node_modules/esbuild');
const { prepareSupportedEdit } = require('../src/server/values');
let hooks, cursor;
const React = {
  useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
  useRef(initial) { const index = cursor++; return hooks[index] ?? (hooks[index] = { current: initial }); },
  useEffect() {},
};
const jsx = (type, props) => ({ type, props });
const compiled = esbuild.buildSync({ stdin: {
  contents: fs.readFileSync(path.join(__dirname, '../ui/src/components/Inspector.tsx'), 'utf8') + '\nexport { AddProperty, Row };',
  resolveDir: path.join(__dirname, '../ui/src/components'), loader: 'tsx',
}, bundle: true, write: false, format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] }).outputFiles[0].text;
const context = { module: { exports: {} }, require: name => name === 'react' ? React : { jsx, jsxs: jsx, Fragment: 'fragment' } };
vm.runInNewContext(compiled, context);
function render(component, props) { cursor = 0; return component(props); }
function find(tree, predicate) {
  if (!tree) return undefined;
  if (Array.isArray(tree)) { for (const item of tree) { const found = find(item, predicate); if (found) return found; } return; }
  if (typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}
const input = tree => find(tree, n => n.type === 'textarea');
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const def = { key: 'opacity', group: '基础外观', inputType: 'number', wireType: 'Float', min: 0, max: 1, description: '0–1' };
  const schema = { id: 1, schemaVersion: 1, schemaToken: 't', properties: [def] };
  const writes = []; let canceled = 0;
  const props = { definitions: [def], onCancel: () => canceled++, onApply: async (key, value) => {
    const command = prepareSupportedEdit({ id: 1 }, { id: 1, key, value, target: 'p', requestId: 'e', schemaToken: 't' }, schema);
    writes.push(command.value); await flush();
  } };
  hooks = [];
  const draw = () => render(context.module.exports.AddProperty, props);
  let tree = draw();
  find(tree, n => n.type === 'select').props.onChange({ target: { value: 'opacity' } });
  tree = draw(); input(tree).props.onBlur(); await flush();
  assert.equal(writes.length, 0, 'empty/unchanged editor must not submit');
  input(tree).props.onChange({ target: { value: '0.5' } }); tree = draw();
  const event = { key: 'Enter', nativeEvent: {}, preventDefault() {} };
  input(tree).props.onKeyDown(event); input(tree).props.onBlur();
  await flush(); await flush();
  assert.deepEqual(writes, [0.5], 'Enter followed by blur submits exactly once');
  tree = draw(); input(tree).props.onChange({ target: { value: '2' } }); tree = draw();
  input(tree).props.onBlur(); await flush(); tree = draw();
  assert.equal(writes.length, 1, 'invalid range must not reach setter');
  assert.equal(input(tree).props.value, '', 'invalid new value clears draft');
  assert.ok(find(tree, n => n.props?.role === 'alert'));
  input(tree).props.onChange({ target: { value: '0.8' } }); tree = draw();
  input(tree).props.onKeyDown({ ...event, key: 'Escape' }); input(tree).props.onBlur(); await flush();
  assert.equal(canceled, 1); assert.equal(writes.length, 1);
  tree = draw(); input(tree).props.onChange({ target: { value: '0.6' } }); tree = draw();
  input(tree).props.onCompositionStart(); input(tree).props.onKeyDown(event); input(tree).props.onBlur(); await flush();
  assert.equal(writes.length, 1, 'IME composition must not submit');
  input(tree).props.onCompositionEnd(); input(tree).props.onKeyDown(event); await flush(); await flush();
  assert.deepEqual(writes, [0.5, 0.6]);
  console.log('ui-properties: ok (empty, Enter/blur dedupe, validation, Escape, IME)');
})().catch(error => { console.error(error); process.exitCode = 1; });
