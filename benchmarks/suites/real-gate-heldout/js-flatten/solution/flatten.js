const isObj = (v) => v !== null && typeof v === 'object';
const escapeKey = (k) => String(k).replace(/\\/g, '\\\\').replace(/\./g, '\\.');

function splitPath(path) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '\\') { cur += path[i + 1]; i++; continue; }
    if (c === '.') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function flatten(obj) {
  const out = {};
  const walk = (val, prefix) => {
    if (!isObj(val)) { out[prefix] = val; return; }
    const keys = Array.isArray(val) ? val.map((_, i) => String(i)) : Object.keys(val);
    if (keys.length === 0) { out[prefix] = val; return; }
    for (const k of keys) {
      const child = escapeKey(k);
      walk(val[k], prefix === '' ? child : prefix + '.' + child);
    }
  };
  if (!isObj(obj)) return obj;
  const keys = Array.isArray(obj) ? obj.map((_, i) => String(i)) : Object.keys(obj);
  if (keys.length === 0) return Array.isArray(obj) ? [] : {};
  for (const k of keys) walk(obj[k], escapeKey(k));
  return out;
}

function isArrayLike(node) {
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  for (let i = 0; i < keys.length; i++) if (!keys.includes(String(i))) return false;
  return true;
}

function unflatten(flat) {
  if (!isObj(flat)) return flat;
  if (Object.keys(flat).length === 0) return Array.isArray(flat) ? [] : {};
  const root = {};
  for (const path of Object.keys(flat)) {
    const parts = splitPath(path);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isObj(node[parts[i]])) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = flat[path];
  }
  const rebuild = (node) => {
    if (!isObj(node) || Array.isArray(node)) return node;
    for (const k of Object.keys(node)) node[k] = rebuild(node[k]);
    if (isArrayLike(node)) return Object.keys(node).map((_, i) => node[String(i)]);
    return node;
  };
  return rebuild(root);
}

module.exports = { flatten, unflatten };
