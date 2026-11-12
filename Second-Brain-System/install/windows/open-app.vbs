' ============================================================================
' install/windows/open-app.vbs
' Opens Second Brain in its own app window with no console flash (desktop / Start menu shortcut).
' ============================================================================
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\open-app.ps1""", 0, False
