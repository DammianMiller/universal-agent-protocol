def normalize_path(p):
    if p == '':
        return '.'
    absolute = p.startswith('/')
    out = []
    for seg in p.split('/'):
        if seg == '' or seg == '.':
            continue
        if seg == '..':
            if out and out[-1] != '..':
                out.pop()
            elif not absolute:
                out.append('..')
            continue
        out.append(seg)
    if absolute:
        return '/' + '/'.join(out)
    return '/'.join(out) if out else '.'
