def format_table(rows, aligns):
    if not isinstance(aligns, str):
        raise ValueError('aligns must be a string')
    for a in aligns:
        if a not in 'lrc':
            raise ValueError('bad alignment %r' % a)
    if not rows:
        return []
    ncols = len(aligns)
    for row in rows:
        if len(row) > ncols:
            raise ValueError('row has %d cells but only %d alignments' % (len(row), ncols))
    padded = [[str(c) for c in row] + [''] * (ncols - len(row)) for row in rows]
    widths = [max((len(r[i]) for r in padded), default=0) for i in range(ncols)]

    out = []
    for row in padded:
        cells = []
        for i, cell in enumerate(row):
            w = widths[i]
            pad = w - len(cell)
            a = aligns[i]
            if a == 'l':
                cells.append(cell + ' ' * pad)
            elif a == 'r':
                cells.append(' ' * pad + cell)
            else:
                left = pad // 2
                cells.append(' ' * left + cell + ' ' * (pad - left))
        out.append(' | '.join(cells).rstrip())
    return out
