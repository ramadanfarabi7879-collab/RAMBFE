' تشغيل المراقب بشكل مخفي من مجلد المشروع أياً كان مكانه على الجهاز
Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
projDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
WshShell.CurrentDirectory = projDir
py = projDir & "\.venv\Scripts\pythonw.exe"
If Not fso.FileExists(py) Then py = "pythonw.exe"
WshShell.Run """" & py & """ """ & projDir & "\scripts\watchdog_service.py""", 0, False
