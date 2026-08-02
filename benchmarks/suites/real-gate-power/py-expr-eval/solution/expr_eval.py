import re

_TOKEN = re.compile(r'\s*(\d+\.\d+|\d+|\*\*|//|[-+*/%()])')


def _tokenize(s):
    out = []
    pos = 0
    while pos < len(s):
        m = _TOKEN.match(s, pos)
        if not m:
            if s[pos:].strip() == '':
                break
            raise ValueError('unexpected character %r' % s[pos])
        out.append(m.group(1))
        pos = m.end()
    return out


def eval_expr(s):
    if not isinstance(s, str):
        raise ValueError('expression must be a string')
    toks = _tokenize(s)
    if not toks:
        raise ValueError('empty expression')
    pos = 0

    def peek():
        return toks[pos] if pos < len(toks) else None

    def eat(expected=None):
        nonlocal pos
        if pos >= len(toks):
            raise ValueError('unexpected end of expression')
        tok = toks[pos]
        if expected is not None and tok != expected:
            raise ValueError('expected %r, got %r' % (expected, tok))
        pos += 1
        return tok

    def atom():
        tok = peek()
        if tok is None:
            raise ValueError('unexpected end of expression')
        if tok == '(':
            eat('(')
            val = expression()
            eat(')')
            return val
        if tok == '-':
            eat('-')
            return -power()
        if tok == '+':
            eat('+')
            return power()
        if re.fullmatch(r'\d+\.\d+', tok):
            eat()
            return float(tok)
        if re.fullmatch(r'\d+', tok):
            eat()
            return int(tok)
        raise ValueError('unexpected token %r' % tok)

    def power():
        base = atom()
        if peek() == '**':
            eat('**')
            return base ** power()
        return base

    def term():
        val = power()
        while peek() in ('*', '/', '//', '%'):
            op = eat()
            rhs = power()
            if op == '*':
                val = val * rhs
            elif op == '/':
                if rhs == 0:
                    raise ZeroDivisionError('division by zero')
                val = val / rhs
            elif op == '//':
                if rhs == 0:
                    raise ZeroDivisionError('integer division by zero')
                val = val // rhs
            else:
                if rhs == 0:
                    raise ZeroDivisionError('modulo by zero')
                val = val % rhs
        return val

    def expression():
        val = term()
        while peek() in ('+', '-'):
            op = eat()
            rhs = term()
            val = val + rhs if op == '+' else val - rhs
        return val

    result = expression()
    if pos != len(toks):
        raise ValueError('trailing input %r' % toks[pos])
    return result
