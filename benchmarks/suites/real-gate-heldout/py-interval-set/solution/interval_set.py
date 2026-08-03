def _check(intervals):
    out = []
    for iv in intervals:
        s, e = iv[0], iv[1]
        if isinstance(s, bool) or isinstance(e, bool) or not isinstance(s, int) or not isinstance(e, int):
            raise ValueError('interval bounds must be ints: %r' % (iv,))
        if s < e:
            out.append((s, e))
    return out


def normalize(intervals):
    items = sorted(_check(intervals))
    merged = []
    for s, e in items:
        if merged and s <= merged[-1][1]:
            if e > merged[-1][1]:
                merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return [tuple(x) for x in merged]


def union(a, b):
    return normalize(list(a) + list(b))


def difference(a, b):
    left = normalize(a)
    cut = normalize(b)
    out = []
    for s, e in left:
        cur = s
        for cs, ce in cut:
            if ce <= cur:
                continue
            if cs >= e:
                break
            if cs > cur:
                out.append((cur, min(cs, e)))
            cur = max(cur, ce)
            if cur >= e:
                break
        if cur < e:
            out.append((cur, e))
    return normalize(out)
