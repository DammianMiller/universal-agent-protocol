import re

_RE = re.compile(
    r'^(-)?P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?'
    r'(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$'
)


def parse_duration(s):
    if not isinstance(s, str):
        raise ValueError('duration must be a string')
    m = _RE.match(s)
    if not m:
        raise ValueError('malformed duration: %r' % s)
    neg, y, mo, d, h, mi, sec = m.groups()
    if all(g is None for g in (y, mo, d, h, mi, sec)):
        raise ValueError('duration has no components: %r' % s)
    if 'T' in s:
        tail = s.split('T', 1)[1]
        if tail == '':
            raise ValueError('T with no time components')
        if not any(g is not None for g in (h, mi, sec)):
            raise ValueError('T with no time components')
    sign = -1 if neg else 1
    out = {
        'years': sign * int(y or 0),
        'months': sign * int(mo or 0),
        'days': sign * int(d or 0),
        'hours': sign * int(h or 0),
        'minutes': sign * int(mi or 0),
        'seconds': sign * float(sec or 0),
    }
    out['total_seconds'] = (
        out['years'] * 365 * 86400
        + out['months'] * 30 * 86400
        + out['days'] * 86400
        + out['hours'] * 3600
        + out['minutes'] * 60
        + out['seconds']
    )
    return out
