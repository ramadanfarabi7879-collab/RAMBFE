Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\PH\.gemini\antigravity\scratch\invoice-matcher-app"
WshShell.Run """C:\Users\PH\.gemini\antigravity\scratch\invoice-matcher-app\.venv\Scripts\pythonw.exe"" ""C:\Users\PH\.gemini\antigravity\scratch\invoice-matcher-app\scripts\watchdog_service.py""", 0, False
