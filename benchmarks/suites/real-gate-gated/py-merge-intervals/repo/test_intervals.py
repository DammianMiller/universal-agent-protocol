# In-repo gate: `python3 test_intervals.py`
from intervals import merge_intervals as m
def main():
    assert m([]) == []
    assert m([[1,3],[2,6],[8,10]]) == [[1,6],[8,10]]
    assert m([[8,10],[1,3]]) == [[1,3],[8,10]]          # unsorted
    assert m([[1,2],[2,3]]) == [[1,3]]                  # touching
    print('ok')
if __name__=='__main__': main()
