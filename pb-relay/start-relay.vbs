' Starts the Playboy HLS relay with no console window.
' Used by the Startup shortcut so 127.0.0.1:8791 is always up.
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\ddude\AppData\Local\Programs\Python\Python311\pythonw.exe"" ""C:\Users\ddude\Documents\Default Project\trending4ever-repo\pb-relay\pb_relay.py"" --port 8791", 0, False
