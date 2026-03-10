/**
 * Calculates the arithmetic mean of an array of numbers.
 *
 * @param numbers - An array of numbers to calculate the average of
 * @returns The arithmetic mean of the numbers, or 0 if the array is empty
 *
 * @example
 * ```typescript
 * calculateAverage([1, 2, 3, 4, 5]); // Returns: 3
 * calculateAverage([10, 20]); // Returns: 15
 * calculateAverage([]); // Returns: 0
 * ```
 */
export function calculateAverage(numbers: number[]): number {
  if (numbers.length === 0) {
    return 0;
  }

  const sum = numbers.reduce((acc, num) => acc + num, 0);
  return sum / numbers.length;
}
