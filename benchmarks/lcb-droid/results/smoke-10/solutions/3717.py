from typing import List


class Solution:
    def minOperations(self, nums: List[int], x: int, k: int) -> int:
        n = len(nums)

        # --- cost of making each length-x window all equal (sum |a - median|) ---
        # Sliding window median via Fenwick trees over compressed values.
        vals = sorted(set(nums))
        m = len(vals)
        comp = {v: i + 1 for i, v in enumerate(vals)}
        pos = [comp[v] for v in nums]

        cnt = [0] * (m + 1)
        tot = [0] * (m + 1)

        def add(bit, i, delta):
            while i <= m:
                bit[i] += delta
                i += i & (-i)

        def prefix(bit, i):
            s = 0
            while i > 0:
                s += bit[i]
                i -= i & (-i)
            return s

        step = 1
        while (step << 1) <= m:
            step <<= 1

        def kth(order):
            # smallest compressed index whose prefix count >= order
            p = 0
            bit = step
            while bit:
                nxt = p + bit
                if nxt <= m and cnt[nxt] < order:
                    p = nxt
                    order -= cnt[nxt]
                bit >>= 1
            return p + 1

        costs = [0] * (n - x + 1)
        window_sum = 0
        for i in range(x):
            add(cnt, pos[i], 1)
            add(tot, pos[i], nums[i])
            window_sum += nums[i]
        for s in range(n - x + 1):
            if s > 0:
                out, inc = s - 1, s + x - 1
                add(cnt, pos[out], -1)
                add(tot, pos[out], -nums[out])
                window_sum -= nums[out]
                add(cnt, pos[inc], 1)
                add(tot, pos[inc], nums[inc])
                window_sum += nums[inc]
            p = kth((x + 1) // 2)
            med = vals[p - 1]
            left_cnt = prefix(cnt, p)
            left_sum = prefix(tot, p)
            costs[s] = (med * left_cnt - left_sum) + (
                (window_sum - left_sum) - med * (x - left_cnt)
            )

        # --- pick k non-overlapping windows of length x with minimum total cost ---
        INF = float("inf")
        prev = [0] * (n + 1)  # t = 0: zero cost using any prefix
        for _ in range(k):
            cur = [INF] * (n + 1)
            for i in range(x, n + 1):
                best = cur[i - 1]
                cand = prev[i - x] + costs[i - x]
                if cand < best:
                    best = cand
                cur[i] = best
            prev = cur
        return int(prev[n])
