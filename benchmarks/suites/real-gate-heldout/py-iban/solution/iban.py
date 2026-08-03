def _to_number(s):
    out = []
    for ch in s:
        if ch.isdigit():
            out.append(ch)
        else:
            out.append(str(ord(ch) - ord('A') + 10))
    return int(''.join(out))


def _normalise(iban):
    return str(iban).replace(' ', '').upper()


def is_valid(iban):
    if not isinstance(iban, str):
        return False
    s = _normalise(iban)
    if not (15 <= len(s) <= 34):
        return False
    if not (s[0:2].isalpha() and s[0:2].isascii()):
        return False
    if not s[2:4].isdigit():
        return False
    if not (s[4:].isalnum() and s[4:].isascii()):
        return False
    if not s.isascii() or not s.isalnum():
        return False
    rearranged = s[4:] + s[0:4]
    try:
        return _to_number(rearranged) % 97 == 1
    except Exception:
        return False


def check_digits(country, bban):
    if not isinstance(country, str) or len(country) != 2 or not country.isalpha() or not country.isascii():
        raise ValueError('country must be two ASCII letters')
    if not isinstance(bban, str) or bban == '' or not bban.isalnum() or not bban.isascii():
        raise ValueError('bban must be non-empty alphanumeric')
    c = country.upper()
    b = bban.upper()
    remainder = _to_number(b + c + '00') % 97
    return '%02d' % (98 - remainder)
