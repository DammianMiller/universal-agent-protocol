def _decode_at(s, i):
    if i >= len(s):
        raise ValueError('unexpected end of input')
    c = s[i]
    if c == 'i':
        j = s.find('e', i + 1)
        if j == -1:
            raise ValueError('unterminated integer')
        body = s[i + 1:j]
        if body == '' or body == '-':
            raise ValueError('empty integer')
        neg = body.startswith('-')
        digits = body[1:] if neg else body
        if not digits.isdigit():
            raise ValueError('bad integer %r' % body)
        if len(digits) > 1 and digits[0] == '0':
            raise ValueError('integer has a leading zero')
        if neg and digits == '0':
            raise ValueError('negative zero')
        return int(body), j + 1
    if c.isdigit():
        j = s.find(':', i)
        if j == -1:
            raise ValueError('unterminated string length')
        length_str = s[i:j]
        if not length_str.isdigit():
            raise ValueError('bad string length')
        if len(length_str) > 1 and length_str[0] == '0':
            raise ValueError('string length has a leading zero')
        length = int(length_str)
        start = j + 1
        end = start + length
        if end > len(s):
            raise ValueError('string runs past end of input')
        return s[start:end], end
    if c == 'l':
        out = []
        i += 1
        while True:
            if i >= len(s):
                raise ValueError('unterminated list')
            if s[i] == 'e':
                return out, i + 1
            val, i = _decode_at(s, i)
            out.append(val)
    if c == 'd':
        out = {}
        last_key = None
        i += 1
        while True:
            if i >= len(s):
                raise ValueError('unterminated dict')
            if s[i] == 'e':
                return out, i + 1
            key, i = _decode_at(s, i)
            if not isinstance(key, str):
                raise ValueError('dict key must be a string')
            if last_key is not None and key <= last_key:
                raise ValueError('dict keys must be sorted and unique')
            last_key = key
            val, i = _decode_at(s, i)
            out[key] = val
    raise ValueError('unexpected token %r at %d' % (c, i))


def decode(s):
    if not isinstance(s, str):
        raise ValueError('input must be a string')
    if s == '':
        raise ValueError('empty input')
    val, i = _decode_at(s, 0)
    if i != len(s):
        raise ValueError('trailing data after value')
    return val
