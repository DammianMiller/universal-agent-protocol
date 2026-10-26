from typing import List
from collections import deque

# Integer infinity: keeps every comparison in the hull exact (big ints), so
# the cross-multiplication below never loses precision the way floats would.
INF = 10 ** 30


class Solution:
    def minimumCost(self, nums: List[int], cost: List[int], k: int) -> int:
        n = len(nums)
        # P[i] = sum(nums[:i]), C[i] = sum(cost[:i])
        P = [0] * (n + 1)
        C = [0] * (n + 1)
        for i in range(n):
            P[i + 1] = P[i] + nums[i]
            C[i + 1] = C[i] + cost[i]

        # dp[t] = min cost covering first t elements with the previous number
        # of subarrays. Transition for j subarrays ending at i:
        #   dp_j[i] = min_{t<i} dp_{j-1}[t] + (P[i] + k*j) * (C[i] - C[t])
        # For fixed j, with x = P[i] + k*j this is
        #   min_t ( -C[t] * x + dp_{j-1}[t] ) + C[i] * x
        # a lower-envelope of lines. C[t] strictly increases, so slopes -C[t]
        # are added in decreasing order and x increases with i: a monotone
        # deque gives O(n) per j, O(n^2) overall.
        prev = [INF] * (n + 1)
        prev[0] = 0
        best = INF

        for j in range(1, n + 1):
            lines = deque()  # (m, b) with decreasing m
            cur = [INF] * (n + 1)
            kj = k * j
            for i in range(1, n + 1):
                t = i - 1
                base = prev[t]
                if base < INF:
                    m, b = -C[t], base
                    if lines and lines[-1][0] == m:
                        if lines[-1][1] <= b:
                            m = None
                        else:
                            lines.pop()
                    if m is not None:
                        while len(lines) >= 2:
                            (m1, b1) = lines[-2]
                            (m2, b2) = lines[-1]
                            # drop (m2,b2) if its useful interval is empty
                            if (b2 - b1) * (m2 - m) >= (b - b2) * (m1 - m2):
                                lines.pop()
                            else:
                                break
                        lines.append((m, b))
                if lines:
                    x = P[i] + kj
                    while len(lines) >= 2 and lines[0][0] * x + lines[0][1] >= lines[1][0] * x + lines[1][1]:
                        lines.popleft()
                    cur[i] = lines[0][0] * x + lines[0][1] + C[i] * x
            if cur[n] < best:
                best = cur[n]
            prev = cur

        return int(best)
