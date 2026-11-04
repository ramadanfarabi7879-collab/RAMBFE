import re

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Let's clean out strings, comments, and regex literals
# 1. Block comments
text = re.sub(r'/\*[\s\S]*?\*/', '', text)
# 2. Line comments
text = re.sub(r'//.*', '', text)

# Now check curly braces balance
stack = []
for line_no, line in enumerate(text.splitlines(), 1):
    # remove strings
    clean_line = re.sub(r"'(\\.|[^'])*'", "''", line)
    clean_line = re.sub(r'"(\\.|[^"])*"', '""', clean_line)
    clean_line = re.sub(r'`(\\.|[^`])*`', '``', clean_line)
    clean_line = re.sub(r'/(\\.|[^/])+/[a-z]*', '//', clean_line)
    
    for col_no, ch in enumerate(clean_line, 1):
        if ch in '({[':
            stack.append((ch, line_no, col_no))
        elif ch in ')}]':
            if not stack:
                print(f"ERROR: Unmatched closing '{ch}' at line {line_no}:{col_no}")
            else:
                top, l, c = stack.pop()
                pair = top + ch
                if pair not in ('()', '{}', '[]'):
                    print(f"ERROR: Mismatched '{ch}' at {line_no}:{col_no}, expected matching for '{top}' from {l}:{c}")

if not stack:
    print("SUCCESS: All brackets, braces, and parentheses in app.js are perfectly balanced!")
else:
    print(f"ERROR: {len(stack)} unclosed items:")
    for item in stack[-5:]:
        print(f"  Unclosed '{item[0]}' from line {item[1]}:{item[2]}")
