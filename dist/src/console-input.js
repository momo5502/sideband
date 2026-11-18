import { spawn } from "node:child_process";
import { join } from "node:path";
import { terminateTree } from "./process-tree.js";
// Only the PID of Sideband's authenticated terminal wrapper is accepted by NativeView.
// Prompt text travels through stdin, never through PowerShell syntax or process arguments.
const script = `
$ErrorActionPreference='Stop'
$reader=New-Object System.IO.StreamReader([Console]::OpenStandardInput(),[System.Text.UTF8Encoding]::new($false))
$payload=$reader.ReadToEnd() | ConvertFrom-Json
$reader.Dispose()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SidebandConsole {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Key {
  [MarshalAs(UnmanagedType.Bool)] public bool Down; public ushort Repeat, Virtual, Scan; public char Character; public uint Control;
 }
 [StructLayout(LayoutKind.Explicit)] public struct Record {
  [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public Key Key;
 }
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteConsoleInputW(IntPtr handle,Record[] records,uint count,out uint written);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static void Send(uint pid,string text,bool escape) {
  FreeConsole(); if(!AttachConsole(pid)) throw new Exception("Cannot attach to the agent console ("+Marshal.GetLastWin32Error()+").");
  IntPtr handle=CreateFileW("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
  if(handle==new IntPtr(-1)) throw new Exception("Cannot open the agent console input.");
  try {
   string value=escape ? "\\u001b" : "\\u001b[200~"+text+"\\u001b[201~\\r";
   Record[] records=new Record[value.Length*2];
   for(int i=0;i<value.Length;i++) {
    var key=new Key{Down=true,Repeat=1,Virtual=(ushort)(escape?27:i==value.Length-1?13:0),Character=value[i]};
    records[i*2]=new Record{Type=1,Key=key}; key.Down=false; records[i*2+1]=new Record{Type=1,Key=key};
   }
   int offset=0; while(offset<records.Length) {
    int count=Math.Min(512,records.Length-offset); Record[] batch=new Record[count];Array.Copy(records,offset,batch,0,count);uint written;
    if(!WriteConsoleInputW(handle,batch,(uint)count,out written)||written==0) throw new Exception("Console input was not accepted."); offset+=(int)written;
   }
  } finally { CloseHandle(handle); FreeConsole(); }
 }
}
'@
[SidebandConsole]::Send([uint32]$payload.pid,[string]$payload.text,[bool]$payload.escape)
`;
export async function consoleInput(pid, text, escape = false) {
    if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1)
        throw new Error("A valid Windows agent console is required.");
    if (text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
        throw new Error("Terminal input cannot contain control characters.");
    await new Promise((resolve, reject) => {
        const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
        let error = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", value => { error = (error + value).slice(-2048); });
        const timer = setTimeout(() => { terminateTree(child); reject(new Error("Console input timed out; acceptance is unknown. Check the terminal before retrying.")); }, 10000);
        child.once("error", failure => { clearTimeout(timer); reject(failure); });
        child.stdin.once("error", failure => { clearTimeout(timer); reject(failure); });
        child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Console input failed: ${error || code}`)); });
        child.stdin.end(JSON.stringify({ pid, text: text.replace(/\r\n?/g, "\n"), escape }));
    });
}
//# sourceMappingURL=console-input.js.map