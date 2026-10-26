import sys

INF = 10**9


def main():
    data = list(map(int, sys.stdin.buffer.read().split()))
    it = iter(data)
    N = next(it)
    M = next(it)
    Q = next(it)

    A = [0] * M
    B = [0] * M
    G = [0] * M
    for i in range(M):
        s = next(it)
        t = next(it)
        if s < t:
            A[i] = s
            B[i] = t
            G[i] = 0
        else:
            A[i] = t
            B[i] = s
            G[i] = 1

    size = 1
    while size < N:
        size <<= 1

    # For each direction group we keep two segment trees over town positions:
    #   tmax[pos_of_left_endpoint]  = right endpoint of the stored interval
    #   tmin[pos_of_right_endpoint] = left endpoint of the stored interval
    # A new interval (a,b) in the same group conflicts with stored ones iff
    #   - some stored interval starts at a or ends at b (handled by counters), or
    #   - some stored interval crosses it: max right endpoint over positions
    #     (a, b) exceeds b, or min left endpoint over (a, b) is below a.
    tmax = [[0] * (2 * size), [0] * (2 * size)]
    tmin = [[INF] * (2 * size), [INF] * (2 * size)]

    cntA = [0] * (N + 2)
    cntB = [0] * (N + 2)

    # two pointers: rmax[L] = largest R such that people L..R are jointly feasible
    rmax = [0] * M
    R = 0
    for L in range(M):
        while R < M:
            a = A[R]
            b = B[R]
            g = G[R]
            if cntA[a] or cntB[b]:
                break
            tm = tmax[g]
            tn = tmin[g]
            l = a + size          # position a+1
            r = b - 2 + size      # position b-1
            bad = False
            while l <= r:
                if l & 1:
                    if tm[l] > b or tn[l] < a:
                        bad = True
                        break
                    l += 1
                if not (r & 1):
                    if tm[r] > b or tn[r] < a:
                        bad = True
                        break
                    r -= 1
                l >>= 1
                r >>= 1
            if bad:
                break
            cntA[a] += 1
            cntB[b] += 1
            p = a - 1 + size
            tm[p] = b
            p >>= 1
            while p:
                lc = p << 1
                nv = tm[lc] if tm[lc] >= tm[lc | 1] else tm[lc | 1]
                if tm[p] == nv:
                    break
                tm[p] = nv
                p >>= 1
            p = b - 1 + size
            tn[p] = a
            p >>= 1
            while p:
                lc = p << 1
                nv = tn[lc] if tn[lc] <= tn[lc | 1] else tn[lc | 1]
                if tn[p] == nv:
                    break
                tn[p] = nv
                p >>= 1
            R += 1
        rmax[L] = R - 1
        # drop interval L and retry extension from the next L
        a = A[L]
        b = B[L]
        g = G[L]
        cntA[a] -= 1
        cntB[b] -= 1
        tm = tmax[g]
        p = a - 1 + size
        tm[p] = 0
        p >>= 1
        while p:
            lc = p << 1
            nv = tm[lc] if tm[lc] >= tm[lc | 1] else tm[lc | 1]
            if tm[p] == nv:
                break
            tm[p] = nv
            p >>= 1
        tn = tmin[g]
        p = b - 1 + size
        tn[p] = INF
        p >>= 1
        while p:
            lc = p << 1
            nv = tn[lc] if tn[lc] <= tn[lc | 1] else tn[lc | 1]
            if tn[p] == nv:
                break
            tn[p] = nv
            p >>= 1

    out = []
    for _ in range(Q):
        l = next(it)
        r = next(it)
        out.append("Yes" if r - 1 <= rmax[l - 1] else "No")
    sys.stdout.write("\n".join(out) + "\n")


main()
