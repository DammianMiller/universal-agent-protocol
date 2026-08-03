def encode(s):
    if not isinstance(s, str):
        raise ValueError('input must be a string')
    if s == '':
        return ''
    out = []
    run_char = s[0]
    run_len = 1
    for ch in s[1:]:
        if ch == run_char:
            run_len += 1
        else:
            out.append('%d[%s]' % (run_len, run_char))
            run_char = ch
            run_len = 1
    out.append('%d[%s]' % (run_len, run_char))
    return ''.join(out)


def decode(s):
    if not isinstance(s, str):
        raise ValueError('input must be a string')
    out = []
    i = 0
    n = len(s)
    while i < n:
        j = i
        while j < n and s[j].isdigit():
            j += 1
        if j == i:
            raise ValueError('expected a count at position %d' % i)
        count_str = s[i:j]
        if len(count_str) > 1 and count_str[0] == '0':
            raise ValueError('count has a leading zero')
        count = int(count_str)
        if count < 1:
            raise ValueError('count must be positive')
        if j >= n or s[j] != '[':
            raise ValueError('expected [ at position %d' % j)
        if j + 1 >= n:
            raise ValueError('unterminated bracket')
        ch = s[j + 1]
        # Check the CLOSING bracket before calling this an empty bracket: the
        # payload is exactly one character, and ']' is a legal payload, so
        # '3[]]' is a valid encoding of ']]]' while '3[]' is malformed.
        if j + 2 >= n or s[j + 2] != ']':
            if ch == ']':
                raise ValueError('empty bracket')
            raise ValueError('expected ] at position %d' % (j + 2))
        out.append(ch * count)
        i = j + 3
    return ''.join(out)
