with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Check with an actual JS parser or tokenizer
# Since we have python, we can check with esprima or slimit or a clean tokenizer
i = 0
n = len(text)
clean = []
while i < n:
    # Single-line comment
    if text[i:i+2] == '//':
        while i < n and text[i] != '\n':
            i += 1
        clean.append('\n')
    # Multi-line comment
    elif text[i:i+2] == '/*':
        i += 2
        while i < n - 1 and text[i:i+2] != '*/':
            if text[i] == '\n': clean.append('\n')
            i += 1
        i += 2
    # Single quote string
    elif text[i] == "'":
        i += 1
        while i < n and text[i] != "'":
            if text[i] == '\\': i += 2
            elif text[i] == '\n': 
                clean.append('\n')
                i += 1
            else: i += 1
        i += 1
    # Double quote string
    elif text[i] == '"':
        i += 1
        while i < n and text[i] != '"':
            if text[i] == '\\': i += 2
            elif text[i] == '\n':
                clean.append('\n')
                i += 1
            else: i += 1
        i += 1
    # Template literal
    elif text[i] == '`':
        i += 1
        while i < n and text[i] != '`':
            if text[i] == '\\': i += 2
            elif text[i:i+2] == '${':
                clean.append('${')
                i += 2
                continue
            elif text[i] == '\n':
                clean.append('\n')
                i += 1
            else: i += 1
        i += 1
    # Regex literal (simple check)
    elif text[i] == '/' and i + 1 < n and text[i+1] not in ('/', '*'):
        # Check if preceded by operator or start
        prev = ''.join(clean).rstrip()
        if prev and prev[-1] in '(=,:[!&|?{};+*-':
            i += 1
            while i < n and text[i] != '/':
                if text[i] == '\\': i += 2
                elif text[i] == '\n': break
                else: i += 1
            i += 1
            # flags
            while i < n and text[i] in 'gimsuy':
                i += 1
        else:
            clean.append(text[i])
            i += 1
    else:
        clean.append(text[i])
        i += 1

cleaned_text = ''.join(clean)
stack = []
lines = 1
errors = []

matches = {'}': '{', ']': '[', ')': '('}
for idx, ch in enumerate(cleaned_text):
    if ch == '\n':
        lines += 1
    elif ch in '{[(':
        stack.append((ch, lines))
    elif ch in '}])':
        if not stack:
            errors.append(f'Unmatched closing {ch} at line {lines}')
        else:
            top, top_line = stack.pop()
            if matches[ch] != top:
                errors.append(f'Mismatched {ch} at line {lines}, expected matching {top} from line {top_line}')

if stack:
    for top, top_line in stack:
        errors.append(f'Unclosed {top} from line {top_line}')

if errors:
    print(f'Total {len(errors)} issues:')
    for e in errors[:10]:
        print('  ', e)
else:
    print('Clean: No JS syntax/bracket errors!')
