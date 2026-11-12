import sys

def main():
    data = sys.stdin.read().split()
    if len(data) < 3:
        return
    n = int(data[0])
    S = data[1]
    T = data[2]

    K = 26
    f = [-1] * K  # f[c] = required image of letter c, -1 if c not in domain
    for a, b in zip(S, T):
        ia = ord(a) - 97
        ib = ord(b) - 97
        if f[ia] == -1:
            f[ia] = ib
        elif f[ia] != ib:
            print(-1)
            return

    indom = [c for c in range(K) if f[c] != -1]
    E = sum(1 for c in indom if f[c] != c)
    if E == 0:
        print(0)
        return

    state = [0] * K  # 0 unvisited, 1 in current walk, 2 done
    oncycle = [False] * K
    C = 0
    for s in indom:
        if state[s]:
            continue
        path = []
        v = s
        while f[v] != -1 and state[v] == 0:
            state[v] = 1
            path.append(v)
            v = f[v]
        if f[v] != -1 and state[v] == 1:
            cyc = [v]
            w = f[v]
            while w != v:
                cyc.append(w)
                w = f[w]
            if len(cyc) >= 2:
                for u in cyc:
                    oncycle[u] = True
                cycset = set(cyc)
                pure = True
                for i in indom:
                    if i not in cycset and f[i] in cycset:
                        pure = False
                        break
                if pure:
                    C += 1
        for u in path:
            state[u] = 2

    if C == 0:
        print(E)
        return

    buffer = False
    for z in range(K):
        if f[z] == -1 or (f[z] != z and not oncycle[z]):
            buffer = True
            break
    print(E + C if buffer else -1)


main()
