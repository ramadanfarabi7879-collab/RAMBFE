import sys

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

i = 0
n = len(text)
stack = []
line = 1
col = 1
errors = []

while i < n:
    ch = text[i]
    if ch == '\n':
        line += 1
        col = 1
        i += 1
        continue
    # Line comment
    if ch == '/' and i + 1 < n and text[i+1] == '/':
        while i < n and text[i] != '\n':
            i += 1
        continue
    # Block comment
    if ch == '/' and i + 1 < n and text[i+1] == '*':
        i += 2
        while i + 1 < n and not (text[i] == '*' and text[i+1] == '/'):
            if text[i] == '\n':
                line += 1
            i += 1
        i += 2
        continue
    # Strings
    if ch in ('"', "'"):
        quote = ch
        i += 1
        while i < n and text[i] != quote:
            if text[i] == '\\':
                i += 2
            else:
                if text[i] == '\n':
                    line += 1
                i += 1
        i += 1
        continue
    # Template literals
    if ch == '`':
        i += 1
        while i < n and text[i] != '`':
            if text[i] == '\\':
                i += 2
            elif text[i] == '$' and i + 1 < n and text[i+1] == '{':
                stack.append(('}', line, col, '`'))
                i += 2
                continue
            else:
                if text[i] == '\n':
                    line += 1
                i += 1
        i += 1
        continue
    # Brackets
    if ch in '({[':
        expected = { '(': ')', '{': '}', '[': ']' }[ch]
        stack.append((expected, line, col, ch))
    elif ch in ')}]':
        if not stack:
            errors.append(f'Unmatched {ch} at line {line}, col {col}')
        else:
            exp, l, c, op = stack.pop()
            if ch != exp:
                errors.append(f'Mismatched {ch} at line {line}, col {col}, expected {exp} opened at line {l}, col {c}')
    i += 1
    col += 1

if stack:
    for exp, l, c, op in stack:
        errors.append(f'Unclosed {op} from line {l}, col {c}')

if not errors:
    print('SUCCESS: JavaScript syntax is 100% clean and balanced!')
else:
    print(f'Found {len(errors)} errors:')
    for e in errors[:10]:
        print(e)
