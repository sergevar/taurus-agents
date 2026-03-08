"""
Sample project file.
Taurus threads can read, edit, and run this code.
"""


def greet(name: str) -> str:
    return f"Hello, {name}!"


def fibonacci(n: int) -> list[int]:
    """Generate first n Fibonacci numbers."""
    if n <= 0:
        return []
    fib = [0, 1]
    while len(fib) < n:
        fib.append(fib[-1] + fib[-2])
    return fib[:n]


if __name__ == "__main__":
    print(greet("World"))
    print(f"First 10 Fibonacci: {fibonacci(10)}")
