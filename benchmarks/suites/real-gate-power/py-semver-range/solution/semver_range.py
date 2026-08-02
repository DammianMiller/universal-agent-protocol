import re

_VER = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$')


def _parse(v):
    m = _VER.match(v.strip())
    if not m:
        raise ValueError('bad version %r' % v)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4))


def _pre_key(pre):
    parts = []
    for p in pre.split('.'):
        if p.isdigit():
            parts.append((0, int(p), ''))
        else:
            parts.append((1, 0, p))
    return parts


def _cmp(a, b):
    for i in range(3):
        if a[i] != b[i]:
            return -1 if a[i] < b[i] else 1
    if a[3] is None and b[3] is None:
        return 0
    if a[3] is None:
        return 1
    if b[3] is None:
        return -1
    ka, kb = _pre_key(a[3]), _pre_key(b[3])
    if ka < kb:
        return -1
    if ka > kb:
        return 1
    return 0


def _expand(tok):
    """Return a list of (op, parsed_version) primitives."""
    tok = tok.strip()
    if not tok:
        return []
    if tok.startswith('^'):
        v = _parse(tok[1:])
        if v[0] > 0:
            upper = (v[0] + 1, 0, 0, None)
        elif v[1] > 0:
            upper = (0, v[1] + 1, 0, None)
        else:
            upper = (0, 0, v[2] + 1, None)
        return [('>=', v), ('<', upper)]
    if tok.startswith('~'):
        v = _parse(tok[1:])
        return [('>=', v), ('<', (v[0], v[1] + 1, 0, None))]
    m = re.match(r'^(>=|<=|>|<|=)?(.*)$', tok)
    op = m.group(1) or '='
    return [(op, _parse(m.group(2)))]


def satisfies(version, range_):
    v = _parse(version)
    if not isinstance(range_, str) or not range_.strip():
        raise ValueError('bad range %r' % range_)
    for clause in range_.split('||'):
        prims = []
        for tok in clause.split():
            prims.extend(_expand(tok))
        if not prims:
            raise ValueError('empty clause in range')
        ok = True
        for op, target in prims:
            c = _cmp(v, target)
            if op == '>=':
                ok = ok and c >= 0
            elif op == '>':
                ok = ok and c > 0
            elif op == '<=':
                ok = ok and c <= 0
            elif op == '<':
                ok = ok and c < 0
            else:
                ok = ok and c == 0
            if not ok:
                break
        if ok and v[3] is not None:
            # A prerelease only counts if a comparator names the same tuple AND
            # is itself a prerelease.
            ok = any(t[3] is not None and t[:3] == v[:3] for _, t in prims)
        if ok:
            return True
    return False
