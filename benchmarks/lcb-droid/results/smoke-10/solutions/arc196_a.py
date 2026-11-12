import sys
from heapq import heappush, heappop


class Halves:
    """Splits the elements seen so far into a lower and upper half of (almost)
    equal size, tracking sum(upper) - sum(lower)."""

    __slots__ = ("lo", "hi", "slo", "shi")

    def __init__(self):
        self.lo = []   # max-heap via negation: the smaller half
        self.hi = []   # min-heap: the larger half
        self.slo = 0
        self.shi = 0

    def add(self, x):
        if self.lo and x <= -self.lo[0]:
            heappush(self.lo, -x)
            self.slo += x
        else:
            heappush(self.hi, x)
            self.shi += x
        # keep every element of lo <= every element of hi
        if self.lo and self.hi and -self.lo[0] > self.hi[0]:
            a = -heappop(self.lo)
            b = heappop(self.hi)
            heappush(self.lo, -b)
            heappush(self.hi, a)
            self.slo += b - a
            self.shi += a - b
        # keep the halves equal in size, lo may hold one extra
        if len(self.lo) > len(self.hi) + 1:
            a = -heappop(self.lo)
            self.slo -= a
            heappush(self.hi, a)
            self.shi += a
        elif len(self.hi) > len(self.lo):
            a = heappop(self.hi)
            self.shi -= a
            heappush(self.lo, -a)
            self.slo += a

    def diff(self):
        """Upper-half sum minus lower-half sum (halves equal in size)."""
        return self.shi - self.slo


def solve() -> None:
    data = sys.stdin.buffer.read().split()
    n = int(data[0])
    a = [int(x) for x in data[1:1 + n]]

    # Each operation scores max - min, so the total is a signed sum: one element
    # of every pair counts +1 (the larger) and the other -1. Removals of
    # adjacent elements give a non-crossing matching, and an unpaired element
    # (only possible when n is odd) is never removed, so it splits the sequence
    # into two even-length parts. For an even-length part the score is at most
    # (sum of its largest half) - (sum of its smallest half); that bound is
    # reachable by signing the largest half +1 and the smallest half -1 and
    # repeatedly removing an adjacent +- pair (one always exists, and every +
    # is >= every -). So: even n -> the bound on the whole array; odd n ->
    # maximise bound(prefix) + bound(suffix) over the leftover sitting at an
    # odd 1-indexed position.
    pref = [0] * (n + 1)
    h = Halves()
    for i, x in enumerate(a):
        h.add(x)
        if (i + 1) % 2 == 0:
            pref[i + 1] = h.diff()

    if n % 2 == 0:
        print(pref[n])
        return

    suff = [0] * n  # suff[t] = bound of the suffix of length t (t even)
    h = Halves()
    for t in range(1, n):
        h.add(a[n - t])
        if t % 2 == 0:
            suff[t] = h.diff()

    best = 0
    for left in range(0, n, 2):  # leftover sits at 0-indexed position `left`
        g = pref[left] + suff[n - 1 - left]
        if g > best:
            best = g
    print(best)


if __name__ == "__main__":
    solve()
