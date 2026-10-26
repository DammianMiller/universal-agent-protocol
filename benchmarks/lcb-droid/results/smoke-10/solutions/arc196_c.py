import sys

MOD = 998244353


def main():
    data = sys.stdin.read().split()
    if not data:
        return
    n = int(data[0])
    s = data[1].strip()
    n2 = 2 * n

    # Strong connectivity <=> every cut k in 1..2N-1 is crossed by a
    # backward edge (a black b<=k paired with a white w>k).
    #
    # Index blacks 1..N and whites 1..N by position order; black p is
    # matched to white pi(p), a permutation.  The binding cut for black
    # set {1..p} is the one just before black p+1, giving the condition
    #     max(pi(1..p)) > u_p   for every p in 1..N-1,
    # where u_p = #whites positioned before black p+1 (nondecreasing).
    # Cuts before the first black / after the last black force
    # S[1]='B' and S[2N]='W'.
    #
    # Inclusion-exclusion over violated cuts E_p = {max(pi(1..p))<=u_p}:
    # for violated cuts j1<...<jt=q the count factorises into blocks,
    # yielding the recurrence
    #     C_q = -(u_q! + sum_{j<q} C_j (u_q - j)!) / (u_q - q)!   (u_q>=q)
    #     ans = N! + sum_q C_q (N - q)!
    # with d! := 0 for d < 0.  The inner sum is an online convolution
    # sum_j C_j * f(u_q - j), f(d) = d!, evaluated at monotone points
    # u_q; solve with CDQ divide and conquer + NTT.
    if s[0] != 'B' or s[-1] != 'W':
        print(0)
        return
    if n == 1:
        print(1)
        return

    fact = [1] * (n + 1)
    for i in range(1, n + 1):
        fact[i] = fact[i - 1] * i % MOD
    invfact = [1] * (n + 1)
    invfact[n] = pow(fact[n], MOD - 2, MOD)
    for i in range(n, 0, -1):
        invfact[i - 1] = invfact[i] * i % MOD

    # u[p] = #whites before black p+1, for p = 1..N-1
    u = [0] * (n + 1)  # 1-indexed
    wc = bc = 0
    for i in range(1, n2):
        if s[i - 1] == 'W':
            wc += 1
        else:
            bc += 1
            p = bc - 1
            if 1 <= p <= n - 1:
                u[p] = wc

    C = [0] * (n + 1)   # C[q]
    G = [0] * (n + 1)   # accumulated sum_j C_j * (u_q - j)!

    g = 3
    while pow(g, (MOD - 1) // 2, MOD) == 1:
        g += 1
    root = [0] * 24
    inv_root = [0] * 24
    root[23] = pow(g, (MOD - 1) >> 23, MOD)
    inv_root[23] = pow(root[23], MOD - 2, MOD)
    for i in range(22, -1, -1):
        root[i] = root[i + 1] * root[i + 1] % MOD
        inv_root[i] = inv_root[i + 1] * inv_root[i + 1] % MOD

    def ntt(a, invert):
        ln = len(a)
        j = 0
        for i in range(1, ln):
            bit = ln >> 1
            while j & bit:
                j ^= bit
                bit >>= 1
            j |= bit
            if i < j:
                a[i], a[j] = a[j], a[i]
        length = 2
        lg = 1
        while length <= ln:
            w = inv_root[lg] if invert else root[lg]
            half = length >> 1
            for i in range(0, ln, length):
                wn = 1
                end = i + half
                for k in range(i, end):
                    x = a[k]
                    y = a[k + half] * wn % MOD
                    u2 = x + y
                    if u2 >= MOD:
                        u2 -= MOD
                    v2 = x - y
                    if v2 < 0:
                        v2 += MOD
                    a[k] = u2
                    a[k + half] = v2
                    wn = wn * w % MOD
            length <<= 1
            lg += 1
        if invert:
            inv_ln = pow(ln, MOD - 2, MOD)
            for i in range(ln):
                a[i] = a[i] * inv_ln % MOD

    def convolution(a, b):
        need = len(a) + len(b) - 1
        size = 1
        while size < need:
            size <<= 1
        fa = a + [0] * (size - len(a))
        fb = b + [0] * (size - len(b))
        ntt(fa, False)
        ntt(fb, False)
        for i in range(size):
            fa[i] = fa[i] * fb[i] % MOD
        ntt(fa, True)
        return fa[:need]

    sys.setrecursionlimit(1000000)

    def cdq(lo, hi):
        # compute C[q] for q in [lo, hi], assuming G[q] already holds
        # contributions from all j < lo
        if lo == hi:
            if u[lo] >= lo:
                C[lo] = (-(fact[u[lo]] + G[lo])) % MOD * invfact[u[lo] - lo] % MOD
            return
        mid = (lo + hi) // 2
        cdq(lo, mid)
        # propagate C[j], j in [lo, mid] into G[q], q in [mid+1, hi]
        dmin = u[mid + 1] - mid
        dmax = u[hi] - lo
        if dmax >= dmin:
            # trim C[j]=0 outside [u[q]-n, u[q]] (factorial vanishes)
            jlo = max(lo, u[hi] - n)
            jhi = min(mid, u[mid + 1])
            if jlo <= jhi:
                A = C[jlo:jhi + 1]
                B = [fact[d] for d in range(dmin, dmax + 1)]
                conv = convolution(A, B)
                off = jlo + dmin
                for q in range(mid + 1, hi + 1):
                    t = u[q] - off
                    if 0 <= t < len(conv):
                        G[q] = (G[q] + conv[t]) % MOD
        cdq(mid + 1, hi)

    cdq(1, n - 1)

    ans = fact[n]
    for q in range(1, n):
        ans = (ans + C[q] * fact[n - q]) % MOD
    print(ans % MOD)


main()
