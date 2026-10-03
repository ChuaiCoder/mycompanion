// @ts-nocheck -- checksum-fixed unmodified upstream methods; typed/validated host boundary.
// Copyright (c) 2023-2026 Steven Ickman, MIT; full license in vector-metric-LICENSE.txt.
// Selected unmodified Vectra method declarations; regenerate with scripts/import-vector-upstream.mjs.
// Host checks finite/nonzero/equal dimensions before calling; no metadata/index filesystem is imported.
export class VectraMetric {
  public static normalize(vector: number[]) {
    // Initialize a variable to store the sum of the squares
    let sum = 0;
    // Loop through the elements of the array
    for (let i = 0; i < vector.length; i++) {
      // Square the element and add it to the sum
      sum += vector[i] * vector[i];
    }
    // Return the square root of the sum
    return Math.sqrt(sum);
  }

  public static normalizedCosineSimilarity(vector1: number[], norm1: number, vector2: number[], norm2: number) {
    // Explicitly return NaN if either norm is zero
    if (norm1 === 0 || norm2 === 0) {
      return NaN;
    }
    // Return the quotient of the dot product and the product of the norms
    return this.dotProduct(vector1, vector2) / (norm1 * norm2);
  }

  private static dotProduct(arr1: number[], arr2: number[]) {
    // Use only overlapping indices to avoid NaN when lengths differ
    const minLen = Math.min(arr1.length, arr2.length);
    let sum = 0;
    for (let i = 0; i < minLen; i++) {
      sum += arr1[i] * arr2[i];
    }
    return sum;
  }
}
