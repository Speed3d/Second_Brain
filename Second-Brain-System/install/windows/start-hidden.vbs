' ============================================================================
' install/windows/start-hidden.vbs
' Runs run-server.ps1 with no visible window (used at logon and by open-app).
' ============================================================================
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\run-server.ps1""", 0, False
