# In-repo gate: run me before claiming done.  `python3 -m pytest -q` or `python3 test_roman.py`
from roman import int_to_roman, roman_to_int
def main():
    for n,s in {1:'I',4:'IV',9:'IX',58:'LVIII',1994:'MCMXCIV'}.items():
        assert int_to_roman(n)==s, (n, int_to_roman(n))
        assert roman_to_int(s)==n, (s, roman_to_int(s))
    for bad in ['IIII','VV']:
        try:
            roman_to_int(bad); raise AssertionError('expected ValueError for '+bad)
        except ValueError:
            pass
    print('ok')
if __name__=='__main__': main()
