# Task: longest strictly increasing subsequence

Given a sequence of N integers, print the length of its longest strictly
increasing subsequence.

## Input

The first integer token in the input is N (0 <= N <= 100000). It is followed
by N integer tokens a_1 ... a_N (-10^9 <= a_i <= 10^9). Tokens are separated
by whitespace and may be spread over any number of lines — read tokens, not
lines. When N is 0 there are no further tokens.

## Output

One line: a single integer, the length of the longest strictly increasing
subsequence (0 when N is 0).

## Notes

- A subsequence keeps the original order but need not be contiguous.
- STRICTLY increasing: equal values do not extend a subsequence.
- A correct solution must run comfortably within limits at N = 100000.
