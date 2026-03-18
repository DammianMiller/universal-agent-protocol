/**
 * Semantic Edge Graph Module for UAP
 *
 * Implements a knowledge graph with semantic edges for efficient memory retrieval.
 */

export interface GraphNode {
  id: string;
  content: string;
  type: 'concept' | 'fact' | 'entity' | 'relationship';
  metadata: Record<string, any>;
  embedding?: number[];
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
  metadata: Record<string, any>;
}

export interface SemanticEdgeGraphConfig {
  maxEdgesPerNode: number;
  similarityThreshold: number;
  decayRate: number;
}

const DEFAULT_CONFIG: SemanticEdgeGraphConfig = {
  maxEdgesPerNode: 50,
  similarityThreshold: 0.7,
  decayRate: 0.95,
};

/**
 * Semantic Edge Graph
 * A knowledge graph with semantic connections between nodes
 */
export class SemanticEdgeGraph {
  private config: SemanticEdgeGraphConfig;
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge[]> = new Map();

  constructor(config: Partial<SemanticEdgeGraphConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a node to the graph
   */
  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.edges.has(node.id)) {
      this.edges.set(node.id, []);
    }
  }

  /**
   * Add an edge between nodes
   */
  addEdge(source: string, target: string, type: string, weight: number = 1.0): void {
    if (!this.nodes.has(source) || !this.nodes.has(target)) {
      throw new Error(`Nodes ${source} and ${target} must exist`);
    }

    const edge: GraphEdge = {
      source,
      target,
      type,
      weight,
      metadata: {},
    };

    // Add edge to both nodes' adjacency lists (undirected)
    this.addEdgeToAdjacency(source, target, edge);
    this.addEdgeToAdjacency(target, source, { ...edge, source: target, target });
  }

  private addEdgeToAdjacency(nodeId: string, targetId: string, edge: GraphEdge): void {
    const adj = this.edges.get(nodeId) || [];

    // Remove existing edge if it exists
    const filtered = adj.filter((e) => e.target !== targetId);

    // Add new edge
    filtered.push(edge);

    // Sort by weight and limit
    filtered.sort((a, b) => b.weight - a.weight);

    if (filtered.length > this.config.maxEdgesPerNode) {
      filtered.length = this.config.maxEdgesPerNode;
    }

    this.edges.set(nodeId, filtered);
  }

  /**
   * Get neighbors of a node
   */
  getNeighbors(nodeId: string, limit?: number): Array<{ nodeId: string; edge: GraphEdge }> {
    const adj = this.edges.get(nodeId) || [];

    if (limit) {
      return adj.slice(0, limit).map((e) => ({ nodeId: e.target, edge: e }));
    }

    return adj.map((e) => ({ nodeId: e.target, edge: e }));
  }

  /**
   * Get all nodes
   */
  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get a node by ID
   */
  getNode(nodeId: string): GraphNode | null {
    return this.nodes.get(nodeId) || null;
  }

  /**
   * Find similar nodes by content
   */
  findSimilar(
    nodeId: string,
    threshold: number = 0.7
  ): Array<{ node: GraphNode; similarity: number }> {
    const node = this.nodes.get(nodeId);
    if (!node || !node.embedding) {
      return [];
    }

    const results: Array<{ node: GraphNode; similarity: number }> = [];

    for (const [id, otherNode] of this.nodes) {
      if (id === nodeId || !otherNode.embedding) continue;

      const similarity = this.cosineSimilarity(node.embedding, otherNode.embedding);
      if (similarity >= threshold) {
        results.push({ node: otherNode, similarity });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Find shortest path between nodes
   */
  findPath(start: string, end: string): string[] | null {
    if (!this.nodes.has(start) || !this.nodes.has(end)) {
      return null;
    }

    const visited = new Set<string>();
    const queue: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      if (node === end) {
        return path;
      }

      if (visited.has(node)) continue;
      visited.add(node);

      const neighbors = this.getNeighbors(node);
      for (const { nodeId: neighborId } of neighbors) {
        if (!visited.has(neighborId)) {
          queue.push({ node: neighborId, path: [...path, neighborId] });
        }
      }
    }

    return null;
  }

  /**
   * Calculate cosine similarity between vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Get graph statistics
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    avgEdgesPerNode: number;
  } {
    const nodeCount = this.nodes.size;
    let edgeCount = 0;

    for (const adj of this.edges.values()) {
      edgeCount += adj.length;
    }

    return {
      nodeCount,
      edgeCount,
      avgEdgesPerNode: nodeCount > 0 ? edgeCount / nodeCount : 0,
    };
  }

  /**
   * Clear the graph
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }
}
