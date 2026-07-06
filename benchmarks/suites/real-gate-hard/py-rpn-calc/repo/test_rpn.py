import rpn

def expect_valueerror(s):
    try:
        rpn.evaluate(s)
    except ValueError:
        return
    raise AssertionError("expected ValueError for: %r" % s)

def main():
    assert rpn.evaluate("2 3 +") == 5
    assert rpn.evaluate("10 4 -") == 6
    assert rpn.evaluate("6 7 *") == 42
    assert rpn.evaluate("20 4 /") == 5
    assert rpn.evaluate("42") == 42
    assert rpn.evaluate("2 3 + 4 *") == 20
    assert rpn.evaluate("5 1 2 + 4 * + 3 -") == 14
    expect_valueerror("1 0 /")      # division by zero
    expect_valueerror("1 2 %")      # unknown operator
    expect_valueerror("1 +")        # insufficient operands
    print("ALL PASS")

main()
