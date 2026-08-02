def chunked(seq, n, strict=False):
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        raise ValueError('n must be a positive int')
    def gen():
        buf = []
        for item in seq:
            buf.append(item)
            if len(buf) == n:
                yield buf
                buf = []
        if buf:
            if strict:
                raise ValueError('incomplete final chunk')
            yield buf
    return gen()
