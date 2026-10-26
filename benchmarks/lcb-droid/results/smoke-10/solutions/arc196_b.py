import sys

MOD = 998244353


def solve():
    data = sys.stdin.buffer.read().split()
    it = iter(data)
    t = int(next(it))
    out = []

    for _ in range(t):
        H = int(next(it))
        W = int(next(it))
        grid = [next(it) for _ in range(H)]

        # Edge variables: x[i][j] = edge between (i,j) and (i,j+1 mod W)
        #                 y[i][j] = edge between (i,j) and (i+1 mod H,j)
        # For cell (i,j): N=y[i-1][j], S=y[i][j], E=x[i][j], W=x[i][j-1].
        # Type A  <=>  N^S==1 and E^W==1
        # Type B  <=>  N==S, E==W and N^E==1
        # So every cell forces y[i-1][j]^y[i][j] = Aflag(i,j) and
        # x[i][j]^x[i][j-1] = Aflag(i,j); B cells additionally couple
        # the free bits with y[i-1][j]^x[i][j] = 1.

        colpar = [0] * W
        rowpar = [0] * H
        for i in range(H):
            r = grid[i]
            p = 0
            for j in range(W):
                if r[j] == 65:  # 'A'
                    p ^= 1
                    colpar[j] ^= 1
            rowpar[i] = p
        if any(rowpar) or any(colpar):
            out.append("0")
            continue

        n = H + W
        parent = list(range(n))
        size = [1] * n
        diff = [0] * n  # value(v) ^ value(parent[v])
        comps = n
        ok = True

        def find(v):
            r = v
            w = 0
            while parent[r] != r:
                w ^= diff[r]
                r = parent[r]
            root = r
            w2 = w
            while parent[v] != v:
                p = parent[v]
                d = diff[v]
                parent[v] = root
                diff[v] = w2
                w2 ^= d
                v = p
            return root, w

        # particular solution for the y-chain of row i, built incrementally:
        # y[i][j] = y[i-1][j] ^ Aflag(i,j), starting from y[-1][j] = 0
        y = [1 if grid[0][j] == 65 else 0 for j in range(W)]

        for i in range(H):
            if not ok:
                break
            r = grid[i]
            x = 0
            for j in range(W):
                if r[j] != 65:  # 'B' cell -> extra constraint
                    w = 1 ^ y[j] ^ x
                    a, wa = find(i)
                    b, wb = find(H + j)
                    if a == b:
                        if (wa ^ wb) != w:
                            ok = False
                            break
                    else:
                        if size[a] < size[b]:
                            a, b = b, a
                            wa, wb = wb, wa
                        parent[b] = a
                        diff[b] = wa ^ wb ^ w
                        size[a] += size[b]
                        comps -= 1
                if j + 1 < W:
                    x ^= 1 if r[j + 1] == 65 else 0
            for j in range(W):
                y[j] ^= 1 if r[j] == 65 else 0

        out.append(str(pow(2, comps, MOD) if ok else "0"))

    sys.stdout.write("\n".join(out) + "\n")


solve()
