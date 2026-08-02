function parse(uri) {
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(uri);
  return { scheme: m[1], authority: m[2], path: m[3] || '', query: m[4], fragment: m[5] };
}

function removeDotSegments(input) {
  let out = '';
  while (input.length) {
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = '/' + input.slice(3);
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) { input = '/' + input.slice(4); out = out.replace(/\/?[^/]*$/, ''); }
    else if (input === '/..') { input = '/'; out = out.replace(/\/?[^/]*$/, ''); }
    else if (input === '.' || input === '..') input = '';
    else {
      const m = /^\/?[^/]*/.exec(input);
      out += m[0];
      input = input.slice(m[0].length);
    }
  }
  return out;
}

module.exports = function resolveUrl(base, ref) {
  const R = parse(ref);
  const B = parse(base);
  const T = {};
  if (R.scheme !== undefined) {
    T.scheme = R.scheme; T.authority = R.authority;
    T.path = removeDotSegments(R.path); T.query = R.query;
  } else {
    if (R.authority !== undefined) {
      T.authority = R.authority; T.path = removeDotSegments(R.path); T.query = R.query;
    } else {
      if (R.path === '') {
        T.path = B.path;
        T.query = R.query !== undefined ? R.query : B.query;
      } else {
        if (R.path.startsWith('/')) T.path = removeDotSegments(R.path);
        else {
          const merged = B.authority !== undefined && B.path === ''
            ? '/' + R.path
            : B.path.replace(/[^/]*$/, '') + R.path;
          T.path = removeDotSegments(merged);
        }
        T.query = R.query;
      }
      T.authority = B.authority;
    }
    T.scheme = B.scheme;
  }
  T.fragment = R.fragment;
  let out = '';
  if (T.scheme !== undefined) out += T.scheme + ':';
  if (T.authority !== undefined) out += '//' + T.authority;
  out += T.path;
  if (T.query !== undefined) out += '?' + T.query;
  if (T.fragment !== undefined) out += '#' + T.fragment;
  return out;
};
