import sys
from heapq import nsmallest

# Reformulation: a pair's price max_d(v_a[d]+v_b[d]) equals choosing one
# coordinate d for the pair and summing v[.][d] over both members, so both
# members carry that label. Hence the answer = max over: pick 2K items,
# label each d in {0,1,2}, every label used an even number of times, of
# sum v[i][label_i].
#
# Ignoring parity, take the 2K items with largest g_i = max_d v[i][d], each
# labeled by an argmax b_i; value = total = sum g_i. Then exactly 0 or 2
# labels have odd counts. If labels p,q are odd, any fix is a set of ops
#   relabel an in-S item labeled a to b : flips {a,b}, cost g_i - v_i[b] >= 0
#   drop   an in-S item labeled a       : flips {a},   cost g_i
#   add    an outside item labeled a    : flips {a},   cost -v_j[a]
# with #drops == #adds and flips XOR-ing to exactly {p,q}; minimize cost.
# Balanced cycles cost >= 0 (each drop's g_i >= each outside g_j >= each
# outside v), so an optimal fix touches <= 2 drops, <= 2 adds and <= 2
# relabels; the top-6 candidates per role therefore contain one. Pool them
# and run an exact DP over (parity mask, drop-add balance).


def solve_case(N, K, items):
    INF = float("inf")
    arr = []
    for x, y, z in items:
        g, b = x, 0
        if y > g:
            g, b = y, 1
        if z > g:
            g, b = z, 2
        arr.append((g, b, x, y, z))
    arr.sort(key=lambda t: -t[0])
    B = 2 * K
    S = arr[:B]
    rest = arr[B:]

    total = 0
    cnt = [0, 0, 0]
    for g, b, x, y, z in S:
        total += g
        cnt[b] += 1
    odd = [d for d in range(3) if cnt[d] & 1]
    if not odd:
        return total
    target = (1 << odd[0]) | (1 << odd[1])

    by_label = [[], [], []]
    for i, it in enumerate(S):
        by_label[it[1]].append(i)

    TOP = 6
    sel = set()
    for d in range(3):
        lst = by_label[d]
        if not lst:
            continue
        sel.update(nsmallest(TOP, lst, key=lambda i: S[i][0]))
        for e in range(3):
            if e != d:
                sel.update(nsmallest(TOP, lst, key=lambda i: S[i][0] - S[i][2 + e]))

    sel_out = set()
    R = len(rest)
    for e in range(3):
        if R:
            sel_out.update(nsmallest(TOP, range(R), key=lambda j: -rest[j][2 + e]))

    BAL = 3
    W = 2 * BAL + 1
    MID = BAL
    dp = [INF] * (8 * W)
    dp[MID] = 0

    for i in sel:
        g, b, x, y, z = S[i]
        v = (x, y, z)
        bitb = 1 << b
        nd = dp[:]
        for mask in range(8):
            row = mask * W
            for bal in range(W):
                cur = dp[row + bal]
                if cur == INF:
                    continue
                for e in range(3):
                    if e == b:
                        continue
                    c = cur + g - v[e]
                    pos = (mask ^ bitb ^ (1 << e)) * W + bal
                    if c < nd[pos]:
                        nd[pos] = c
                if bal + 1 < W:
                    c = cur + g
                    pos = (mask ^ bitb) * W + bal + 1
                    if c < nd[pos]:
                        nd[pos] = c
        dp = nd

    for j in sel_out:
        g, b, x, y, z = rest[j]
        v = (x, y, z)
        nd = dp[:]
        for mask in range(8):
            row = mask * W
            for bal in range(1, W):
                cur = dp[row + bal]
                if cur == INF:
                    continue
                for e in range(3):
                    c = cur - v[e]
                    pos = (mask ^ (1 << e)) * W + bal - 1
                    if c < nd[pos]:
                        nd[pos] = c
        dp = nd

    return total - dp[target * W + MID]


def main():
    data = list(map(int, sys.stdin.buffer.read().split()))
    it = iter(data)
    T = next(it)
    out = []
    for _ in range(T):
        N = next(it)
        K = next(it)
        items = [(next(it), next(it), next(it)) for _ in range(N)]
        out.append(str(solve_case(N, K, items)))
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
