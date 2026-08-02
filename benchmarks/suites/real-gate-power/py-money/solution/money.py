import re
class Money:
    _RE = re.compile(r'^-?\d+\.\d{2}$|^-?\d+$|^-?\d+\.\d$')
    def __init__(self, amount, _cents=None):
        if _cents is not None:
            self.cents = _cents; return
        if not isinstance(amount, str) or not self._RE.match(amount.strip()):
            raise ValueError('bad amount: %r' % (amount,))
        s = amount.strip()
        neg = s.startswith('-')
        if neg: s = s[1:]
        if '.' in s:
            whole, frac = s.split('.')
            frac = (frac + '00')[:2]
        else:
            whole, frac = s, '00'
        c = int(whole) * 100 + int(frac)
        self.cents = -c if neg else c
    def __add__(self, o):
        if not isinstance(o, Money): raise TypeError('Money required')
        return Money(None, _cents=self.cents + o.cents)
    def __sub__(self, o):
        if not isinstance(o, Money): raise TypeError('Money required')
        return Money(None, _cents=self.cents - o.cents)
    def __mul__(self, k):
        if not isinstance(k, int) or isinstance(k, bool): raise TypeError('int required')
        return Money(None, _cents=self.cents * k)
    def __eq__(self, o): return isinstance(o, Money) and o.cents == self.cents
    def __str__(self):
        sign = '-' if self.cents < 0 else ''
        a = abs(self.cents)
        return '%s%d.%02d' % (sign, a // 100, a % 100)
