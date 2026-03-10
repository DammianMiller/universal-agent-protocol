/**
 * Result type for shortest path calculation
 */
export interface ShortestPathResult {
  path: string[];
  distance: number;
}

/**
 * Finds the shortest path between two nodes in a weighted graph using Dijkstra's algorithm.
 *
 * @param graph - Weighted graph as adjacency list Map<node, Map<neighbor, weight>>
 * @param start - Starting node
 * @param end - Target node
 * @returns ShortestPathResult with path and distance, or null if no path exists
 */
export function findShortestPath(
  graph: Map<string, Map<string, number>>,
  start: string,
  end: string
): ShortestPathResult | null {
  // Handle edge case: start equals end
  if (start === end) {
    // Check if node exists in graph
    if (!graph.has(start)) {
      return null;
    }
    return { path: [start], distance: 0 };
  }

  // Check if both nodes exist in the graph
  if (!graph.has(start) || !graph.has(end)) {
    return null;
  }

  // Distance from start to each node
  const distances = new Map<string, number>();
  // Previous node in optimal path
  const previous = new Map<string, string | null>();
  // Unvisited nodes
  const unvisited = new Set<string>();

  // Initialize distances
  for (const node of graph.keys()) {
    distances.set(node, node === start ? 0 : Infinity);
    previous.set(node, null);
    unvisited.add(node);
  }

  while (unvisited.size > 0) {
    // Find unvisited node with smallest distance
    let current: string | null = null;
    let smallestDistance = Infinity;

    for (const node of unvisited) {
      const dist = distances.get(node) ?? Infinity;
      if (dist < smallestDistance) {
        smallestDistance = dist;
        current = node;
      }
    }

    // No reachable nodes left
    if (current === null || smallestDistance === Infinity) {
      break;
    }

    // Found the end node
    if (current === end) {
      break;
    }

    // Remove current from unvisited
    unvisited.delete(current);

    // Update distances to neighbors
    const neighbors = graph.get(current);
    if (neighbors) {
      for (const [neighbor, weight] of neighbors) {
        if (unvisited.has(neighbor)) {
          const newDistance = smallestDistance + weight;
          const currentDistance = distances.get(neighbor) ?? Infinity;

          if (newDistance < currentDistance) {
            distances.set(neighbor, newDistance);
            previous.set(neighbor, current);
          }
        }
      }
    }
  }

  // Check if end node was reached
  const endDistance = distances.get(end);
  if (endDistance === undefined || endDistance === Infinity) {
    return null;
  }

  // Reconstruct path
  const path: string[] = [];
  let current: string | null = end;

  while (current !== null) {
    path.unshift(current);
    current = previous.get(current) ?? null;
  }

  // Verify path starts with start node
  if (path[0] !== start) {
    return null;
  }

  return {
    path,
    distance: endDistance,
  };
}
