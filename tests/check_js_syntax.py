import re

def check_js_syntax(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        text = f.read()

    # We can use a tokenizer approach
    stack = []
    i = 0
    n = len(text)
    line = 1
    col = 1

    while i < n:
        ch = text[i]
        if ch == '\n':
            line += 1
            col = 1
            i += 1
            continue

        # Single-line comment
        if ch == '/' and i + 1 < n and text[i+1] == '/':
            while i < n and text[i] != '\n':
                i += 1
            continue

        # Multi-line comment
        if ch == '/' and i + 1 < n and text[i+1] == '*':
            i += 2
            col += 2
            while i + 1 < n and not (text[i] == '*' and text[i+1] == '/'):
                if text[i] == '\n':
                    line += 1
                    col = 1
                else:
                    col += 1
                i += 1
            i += 2
            col += 2
            continue

        # String literals
        if ch in ('"', "'", '`'):
            quote = ch
            i += 1
            col += 1
            while i < n:
                if text[i] == '\\':
                    i += 2
                    col += 2
                    continue
                if text[i] == quote:
                    i += 1
                    col += 1
                    break
                if text[i] == '\n':
                    line += 1
                    col = 1
                else:
                    col += 1
                i += 1
            continue

        # Regex literal detection: preceded by = ( , : [ ! ? & | ; or return
        if ch == '/':
            # look behind to see if regex
            prev_idx = i - 1
            while prev_idx >= 0 and text[prev_idx] in ' \t\r\n':
                prev_idx -= 1
            prev_char = text[prev_idx] if prev_idx >= 0 else ''
            if prev_char in '=(,:?[!&|;{}':
                # regex literal
                i += 1
                col += 1
                in_class = False
                while i < n:
                    if text[i] == '\\':
                        i += 2
                        col += 2
                        continue
                    if text[i] == '[':
                        in_class = True
                    elif text[i] == ']':
                        in_class = False
                    elif text[i] == '/' and not in_class:
                        i += 1
                        col += 1
                        # skip flags
                        while i < n and text[i] in 'gimsuy':
                            i += 1
                            col += 1
                        break
                    if text[i] == '\n':
                        break
                    i += 1
                    col += 1
                continue

        if ch in '{[(':
            stack.append((ch, line, col))
        elif ch in '}])':
            if not stack:
                print(f"Error: Unmatched closing '{ch}' at line {line}:{col}")
                return False
            last, l_idx, c_idx = stack.pop()
            match = {'}': '{', ']': '[', ')': '('}
            if match[ch] != last:
                print(f"Error: Mismatched '{last}' from line {l_idx}:{c_idx} closed by '{ch}' at line {line}:{col}")
                return False

        i += 1
        col += 1

    if stack:
        print(f"Error: {len(stack)} unclosed delimiters:")
        for ch, l_idx, c_idx in stack[-10:]:
            print(f"  Unclosed '{ch}' opened at line {l_idx}:{c_idx}")
        return False

    print("SUCCESS: All brackets, braces, and parentheses match perfectly!")
    return True

if __name__ == '__main__':
    check_js_syntax('frontend/app.js')
