from typing import List


class Solution:
    def maxProduct(self, nums: List[int], k: int, limit: int) -> int:
        n = len(nums)
        # |alternating sum| can never exceed 12 * n
        OFF = 12 * n
        if k < -OFF or k > OFF:
            return -1
        MASK = (1 << (2 * OFF + 1)) - 1
        target = 1 << (k + OFF)
        ZERO_SUM = 1 << OFF  # the empty subsequence: even length, sum 0

        # product -> bitset of alternating sums reachable by a subsequence of
        # that product whose elements are all non-zero (bit i means sum i - OFF).
        # dp0: even length (non-empty), dp1: odd length.
        dp0 = {}
        dp1 = {}

        # Product-agnostic reachability (bitsets), used to track subsequences
        # that contain at least one zero -- those always have product 0, so
        # they cannot live in the product-keyed maps above.
        r0 = ZERO_SUM  # even length (empty included)
        r1 = 0         # odd length
        z0 = 0         # even length, contains a zero
        z1 = 0         # odd length, contains a zero

        for v in nums:
            nd0 = dp0.copy()
            nd1 = dp1.copy()
            if v != 0:
                if v <= limit:
                    # v as the only element
                    nd1[v] = nd1.get(v, 0) | (1 << (v + OFF))
                for p, bits in dp1.items():
                    q = p * v
                    if q <= limit:
                        # appended at an odd index -> subtract
                        nd0[q] = nd0.get(q, 0) | (bits >> v)
                for p, bits in dp0.items():
                    q = p * v
                    if q <= limit:
                        # appended at an even index -> add
                        nd1[q] = nd1.get(q, 0) | ((bits << v) & MASK)

            # zero-product states: appending a non-zero keeps product 0
            oz0, oz1 = z0, z1
            or0, or1 = r0, r1
            z0 = oz0 | (oz1 >> v)
            z1 = oz1 | ((oz0 << v) & MASK)
            if v == 0:
                # appending this 0 to any (possibly empty) subsequence
                z0 |= or1
                z1 |= or0 | ZERO_SUM
            # refresh product-agnostic reachability
            r0 = or0 | (or1 >> v)
            r1 = or1 | ((or0 << v) & MASK)
            dp0, dp1 = nd0, nd1

        ans = -1
        for p, bits in dp0.items():
            if bits & target and p > ans:
                ans = p
        for p, bits in dp1.items():
            if bits & target and p > ans:
                ans = p
        if ans < 0 and (z0 | z1) & target:
            ans = 0
        return ans
