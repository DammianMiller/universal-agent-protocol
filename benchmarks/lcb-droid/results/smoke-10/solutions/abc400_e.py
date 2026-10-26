import sys
from math import isqrt

# A 400 number is N = p^(2a) * q^(2b) with p, q distinct primes and a,b >= 1,
# i.e. N = m^2 where m = p^a * q^b has exactly two distinct prime factors.
# So the answer for a query A is (largest m <= isqrt(A) with omega(m) == 2)^2.


def main():
    data = sys.stdin.buffer.read().split()
    if not data:
        return
    queries = [int(x) for x in data[1:]]
    if not queries:
        return

    limit = max(isqrt(a) for a in queries)  # at most 10^6

    # omega[n] = number of distinct prime factors of n, via a prime sieve.
    omega = bytearray(limit + 1)
    for i in range(2, limit + 1):
        if omega[i] == 0:  # i is prime
            for j in range(i, limit + 1, i):
                omega[j] += 1

    # prev[n] = largest m <= n with exactly two distinct prime factors.
    prev = [0] * (limit + 1)
    last = 0
    for n in range(2, limit + 1):
        if omega[n] == 2:
            last = n
        prev[n] = last

    sys.stdout.write("\n".join(str(prev[isqrt(a)] ** 2) for a in queries) + "\n")


if __name__ == "__main__":
    main()
