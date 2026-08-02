import heapq


def topo_sort(graph):
    nodes = set(graph)
    for succs in graph.values():
        nodes.update(succs)
    indeg = {n: 0 for n in nodes}
    for n in graph:
        for s in graph[n]:
            indeg[s] += 1

    heap = [n for n in nodes if indeg[n] == 0]
    heapq.heapify(heap)
    out = []
    while heap:
        n = heapq.heappop(heap)
        out.append(n)
        for s in graph.get(n, []):
            indeg[s] -= 1
            if indeg[s] == 0:
                heapq.heappush(heap, s)
    if len(out) != len(nodes):
        raise ValueError('graph contains a cycle')
    return out
