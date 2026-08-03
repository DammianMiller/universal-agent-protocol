import re


def slugify(text, max_length=None):
    if max_length is not None:
        if not isinstance(max_length, int) or isinstance(max_length, bool) or max_length < 1:
            raise ValueError('max_length must be a positive integer')
    s = re.sub(r'[^a-z0-9]+', '-', str(text).lower()).strip('-')
    if max_length is None or len(s) <= max_length:
        return s
    cut = s[:max_length]
    if s[max_length] == '-':
        # The cut landed exactly on a word boundary, so nothing is partial.
        candidate = cut.rstrip('-')
    elif '-' in cut:
        candidate = cut.rsplit('-', 1)[0].rstrip('-')
    else:
        candidate = ''
    if candidate:
        return candidate
    # The first word alone already exceeds the budget: hard-truncate it.
    return cut.rstrip('-') or cut
