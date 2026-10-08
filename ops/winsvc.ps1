# Nexo Lab · estado, inicio o reinicio de UN servicio de Windows en una VM del laboratorio (WinRM).
# Solo lo ejecuta control.py, que ya validó la VM, su IP y que el servicio está en la lista de control.json.
# Entrada: JSON por la entrada estándar. Salida: una línea JSON. La credencial se lee del Administrador de
# credenciales de Windows dentro de este proceso y nunca se escribe.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Out-Result($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); exit 0 }
function Fail([string]$msg) { Out-Result @{ ok = $false; error = $msg } }

try { $req = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { Fail 'Entrada no válida.' }
if (@('status', 'start', 'restart') -notcontains $req.op) { Fail 'Operación no permitida.' }
if ([string]$req.nombre -notmatch '^[A-Za-z0-9@._-]{1,64}$') { Fail 'Nombre de servicio no válido.' }
$ip = $null
if (-not [Net.IPAddress]::TryParse([string]$req.equipo, [ref]$ip)) { Fail 'La dirección de la VM no es válida.' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexoCredW {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static System.Net.NetworkCredential Get(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      string pw = c.CredentialBlobSize > 0 ? Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2) : "";
      return new System.Net.NetworkCredential(c.UserName ?? "", pw);
    } finally { CredFree(p); }
  }
}
'@
$nc = [NexoCredW]::Get([string]$req.credencial)
if (-not $nc) { Fail "No existe la credencial de Windows «$($req.credencial)»." }
$psc = New-Object Management.Automation.PSCredential($nc.UserName, $nc.SecurePassword)
$so = New-PSSessionOption -OpenTimeout 10000 -OperationTimeout 90000
$sb = {
  param([string]$n, [string]$op)
  $s = Get-Service -Name $n -ErrorAction Stop
  if ($op -eq 'start' -and $s.Status -ne 'Running') { Start-Service -Name $n -ErrorAction Stop }
  elseif ($op -eq 'restart') { Restart-Service -Name $n -ErrorAction Stop }   # sin -Force: no detiene servicios dependientes
  (Get-Service -Name $n).Status.ToString()
}
try {
  $st = Invoke-Command -ComputerName $ip.ToString() -Credential $psc -SessionOption $so -ScriptBlock $sb -ArgumentList ([string]$req.nombre), ([string]$req.op)
  Out-Result @{ ok = $true; estado = [string]$st }
} catch {
  $m = $_.Exception.Message
  if ($m -match 'dependent|dependientes') { Fail "Windows no reinicia $($req.nombre) porque otros servicios dependen de él. El panel no los detiene; hazlo dentro de la VM si el diagnóstico lo justifica. ($m)" }
  Fail "WinRM no pudo completar la operación: $m"
}
