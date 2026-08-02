def parse_ini(text):
    out = {}
    section = ''
    out[section] = {}
    for raw in text.split('\n'):
        line = raw.strip()
        if not line or line[0] in ';#':
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1].strip()
            out.setdefault(section, {})
            continue
        if '=' not in line:
            raise ValueError('bad line: %r' % (raw,))
        k, v = line.split('=', 1)
        out.setdefault(section, {})[k.strip()] = v.strip()
    if not out.get(''):
        out.pop('', None)
    return out
