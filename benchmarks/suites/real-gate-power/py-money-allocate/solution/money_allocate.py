from fractions import Fraction


def allocate(total_cents, ratios):
    if not isinstance(ratios, (list, tuple)) or len(ratios) == 0:
        raise ValueError('ratios must be a non-empty sequence')
    for r in ratios:
        if r < 0:
            raise ValueError('ratios must be non-negative')
    total_ratio = sum(ratios)
    if total_ratio == 0:
        raise ValueError('ratios must not sum to zero')

    exact = [Fraction(total_cents) * Fraction(r) / Fraction(total_ratio) for r in ratios]
    if total_cents >= 0:
        base = [int(e // 1) for e in exact]          # floor
    else:
        base = [-int((-e) // 1) for e in exact]      # ceil, so the leftover is negative
    remainder = total_cents - sum(base)
    if remainder == 0:
        return base

    frac = [exact[i] - base[i] for i in range(len(ratios))]
    # Only a share that is actually entitled to money may absorb a leftover cent;
    # a ratio of 0 must stay 0 even when the leftover is negative and its zero
    # fraction would otherwise sort to the front.
    eligible = [i for i in range(len(ratios)) if ratios[i] > 0]
    # Largest fractional remainder wins, and "largest" flips with the sign: for a
    # negative total the shares are ceilings, so the ones furthest BELOW their
    # base are the ones that owe a cent.
    if remainder > 0:
        order = sorted(eligible, key=lambda i: (-frac[i], i))
        step = 1
    else:
        order = sorted(eligible, key=lambda i: (frac[i], i))
        step = -1
    # |remainder| < len(eligible) always, since each eligible share contributes
    # strictly less than one cent of rounding error.
    for k in range(abs(remainder)):
        base[order[k]] += step
    return base
