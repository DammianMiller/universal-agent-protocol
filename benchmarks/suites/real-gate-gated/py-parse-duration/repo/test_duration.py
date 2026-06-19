# In-repo gate: `python3 test_duration.py`
from duration import parse_duration as p
def main():
    assert p('45s')==45
    assert p('2d')==172800
    assert p('1h30m')==5400
    for bad in ['', 'abc']:
        try: p(bad); raise AssertionError('expected ValueError: '+repr(bad))
        except ValueError: pass
    print('ok')
if __name__=='__main__': main()
