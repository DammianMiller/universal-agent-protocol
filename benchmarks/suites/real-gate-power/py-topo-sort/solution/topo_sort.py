def topo_sort(graph):
    nodes = set(graph)
    for deps in graph.values():
        nodes.update(deps)
    remaining = {n: set(graph.get(n, [])) for n in nodes}
    out = []
    while remaining:
        ready = sorted(n for n, d in remaining.items() if not d)
        if not ready:
            raise ValueError('cycle')
        for n in ready:
            out.append(n)
            del remaining[n]
        for d in remaining.values():
            d.difference_update(ready)
    return out
