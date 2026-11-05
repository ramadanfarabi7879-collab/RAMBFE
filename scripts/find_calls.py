import sys
sys.stdout.reconfigure(encoding='utf-8')

def main():
    with open('frontend/app.js', 'r', encoding='utf-8') as f:
        text = f.read()

    idx = 0
    while True:
        pos = text.find('openBatchEntryCard(', idx)
        if pos == -1:
            break
        print(f"Found call at {pos}:")
        print(text[max(0, pos-100):pos+150])
        print("="*60)
        idx = pos + 1

if __name__ == '__main__':
    main()
