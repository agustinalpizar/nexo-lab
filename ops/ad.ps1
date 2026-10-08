# Nexo Lab · operaciones de Active Directory. Solo lo ejecuta control.py.
#
# - Entrada: un objeto JSON por la entrada estándar (nunca por argumentos visibles en la lista de procesos).
# - Salida: una línea JSON { ok, ... } o { ok: false, error }.
# - La credencial se lee del Administrador de credenciales de Windows dentro de este proceso. Ni el usuario
#   ni la contraseña se escriben en la salida. La contraseña temporal (solo en «reset») llega por la entrada
#   estándar y no se escribe en ningún sitio.
# - Conexión LDAP con firma y cifrado (Negotiate + signing + sealing). No se usa LDAP sin cifrar.
# - Operaciones: probe, search, get (lectura) y unlock, enable, disable, reset (escritura).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Out-Result($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); exit 0 }
function Fail([string]$msg) { Out-Result @{ ok = $false; error = $msg } }

try { $req = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { Fail 'Entrada no válida.' }
$ops = 'probe', 'search', 'get', 'unlock', 'enable', 'disable', 'reset'
if ($ops -notcontains $req.op) { Fail 'Operación no permitida.' }
if ([string]$req.servidor -notmatch '^[A-Za-z0-9.\-]{1,253}$') { Fail 'Servidor no válido.' }
if ($req.cuenta -and [string]$req.cuenta -notmatch '^[\w.\- ]{1,64}\$?$') { Fail 'Cuenta no válida.' }

Add-Type -AssemblyName System.DirectoryServices, System.DirectoryServices.Protocols
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexoCred {
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
      string user = c.UserName ?? "", domain = "";
      int i = user.IndexOf('\\');
      if (i > 0) { domain = user.Substring(0, i); user = user.Substring(i + 1); }
      return new System.Net.NetworkCredential(user, pw, domain);
    } finally { CredFree(p); }
  }
}
'@

$cred = [NexoCred]::Get([string]$req.credencial)
if (-not $cred) { Fail "No existe la credencial de Windows «$($req.credencial)»." }
$userForAdsi = if ($cred.Domain) { "$($cred.Domain)\$($cred.UserName)" } else { $cred.UserName }
$auth = [DirectoryServices.AuthenticationTypes]'Secure, Signing, Sealing'

function Entry([string]$path) {
  New-Object DirectoryServices.DirectoryEntry("LDAP://$($req.servidor)/$($path -replace '/', '\/')", $userForAdsi, $cred.Password, $auth)
}
function Esc([string]$s) { $s -replace '\\', '\5c' -replace '\*', '\2a' -replace '\(', '\28' -replace '\)', '\29' -replace "`0", '\00' }
function FileTime($v) { if ($v -and [int64]$v -gt 0 -and [int64]$v -lt [int64]::MaxValue) { [DateTime]::FromFileTimeUtc([int64]$v).ToString('o') } else { $null } }
function CnOf([string]$dn) { ($dn -split '(?<!\\),')[0] -replace '^(CN|OU)=', '' -replace '\\(.)', '$1' }

try {
  $root = Entry 'RootDSE'
  $base = [string]$root.Properties['defaultNamingContext'].Value
  if (-not $base) { Fail 'DC01 respondió, pero no informó el dominio (defaultNamingContext).' }
} catch { Fail "No se pudo conectar con el controlador de dominio $($req.servidor): $($_.Exception.Message)" }

$privBuiltin = @{ 'S-1-5-32-544' = 'Administradores (BUILTIN)'; 'S-1-5-32-548' = 'Account Operators'; 'S-1-5-32-549' = 'Server Operators';
                  'S-1-5-32-550' = 'Print Operators'; 'S-1-5-32-551' = 'Backup Operators' }
$privDomain = @{ 512 = 'Domain Admins'; 518 = 'Schema Admins'; 519 = 'Enterprise Admins'; 520 = 'Group Policy Creator Owners';
                 526 = 'Key Admins'; 527 = 'Enterprise Key Admins' }

function Read-AdItem([string]$dn) {
  $props = 'sAMAccountName', 'cn', 'displayName', 'distinguishedName', 'objectClass', 'objectSid', 'userAccountControl',
           'msDS-User-Account-Control-Computed', 'tokenGroups', 'memberOf', 'member', 'adminCount', 'pwdLastSet',
           'lastLogonTimestamp', 'whenCreated', 'description', 'operatingSystem', 'dNSHostName'
  $s = New-Object DirectoryServices.DirectorySearcher((Entry $dn), '(objectClass=*)', [string[]]$props, [DirectoryServices.SearchScope]::Base)
  $r = $s.FindOne()
  if (-not $r) { Fail 'La cuenta no existe en el directorio.' }
  $p = $r.Properties
  $one = { param($n) if ($p[$n].Count) { $p[$n][0] } else { $null } }
  $classes = @($p['objectclass'])
  $kind = if ($classes -contains 'computer') { 'computer' } elseif ($classes -contains 'group') { 'group' } elseif ($classes -contains 'user') { 'user' } else { 'other' }
  $sid = if (& $one 'objectsid') { New-Object Security.Principal.SecurityIdentifier((& $one 'objectsid'), 0) } else { $null }
  $item = [ordered]@{
    sam = [string](& $one 'samaccountname'); name = [string]$(if (& $one 'displayname') { & $one 'displayname' } else { & $one 'cn' })
    kind = $kind; dn = [string](& $one 'distinguishedname'); description = [string](& $one 'description')
    created = $(if (& $one 'whencreated') { ([DateTime](& $one 'whencreated')).ToUniversalTime().ToString('o') } else { $null })
    rid = $(if ($sid) { [int]($sid.Value -split '-')[-1] } else { $null })
  }
  if ($kind -eq 'user' -or $kind -eq 'computer') {
    $uac = [int](& $one 'useraccountcontrol'); $computed = [int](& $one 'msds-user-account-control-computed')
    $item.enabled = -not ($uac -band 2)
    $item.lastLogon = FileTime (& $one 'lastlogontimestamp')
  }
  if ($kind -eq 'user') {
    $item.locked = [bool]($computed -band 0x10)
    $item.pwdExpired = [bool]($computed -band 0x800000)
    $pls = & $one 'pwdlastset'
    $item.mustChange = ($null -ne $pls -and [int64]$pls -eq 0)
    $item.pwdLastSet = FileTime $pls
    $item.groups = @($p['memberof'] | ForEach-Object { CnOf $_ } | Sort-Object)
    $by = New-Object Collections.Generic.List[string]
    if ([int](& $one 'admincount') -eq 1) { $by.Add('adminCount = 1 (protegida por AdminSDHolder)') }
    if ($item.rid -eq 500) { $by.Add('cuenta integrada de administrador') }
    if ($item.rid -eq 502) { $by.Add('krbtgt') }
    foreach ($b in $p['tokengroups']) {
      $g = (New-Object Security.Principal.SecurityIdentifier($b, 0))
      if ($privBuiltin.ContainsKey($g.Value)) { $by.Add($privBuiltin[$g.Value]) }
      elseif ($sid -and $g.AccountDomainSid -and $g.AccountDomainSid.Value -eq $sid.AccountDomainSid.Value) {
        $rid = [int]($g.Value -split '-')[-1]
        if ($privDomain.ContainsKey($rid)) { $by.Add($privDomain[$rid]) }
      }
    }
    $item.privilegedBy = @($by | Select-Object -Unique)
    $item.privileged = $item.privilegedBy.Count -gt 0
  } elseif ($kind -eq 'group') {
    $item.members = @($p['member'] | Select-Object -First 50 | ForEach-Object { CnOf $_ })
    $item.memberCount = $p['member'].Count
  } elseif ($kind -eq 'computer') {
    $item.os = [string](& $one 'operatingsystem'); $item.dns = [string](& $one 'dnshostname')
  }
  $item
}

function Get-Uac([string]$dn) {
  $s = New-Object DirectoryServices.DirectorySearcher((Entry $dn), '(objectClass=*)', [string[]]@('userAccountControl'), [DirectoryServices.SearchScope]::Base)
  [int]$s.FindOne().Properties['useraccountcontrol'][0]
}

function Find-Dn([string]$sam) {
  $s = New-Object DirectoryServices.DirectorySearcher((Entry $base), "(sAMAccountName=$(Esc $sam))")
  $s.PropertiesToLoad.Add('distinguishedName') | Out-Null
  $r = $s.FindOne()
  if (-not $r) { Fail 'La cuenta no existe en el directorio.' }
  [string]$r.Properties['distinguishedname'][0]
}

function Modify([string]$dn, [string]$attr, $value) {
  $id = New-Object DirectoryServices.Protocols.LdapDirectoryIdentifier([string]$req.servidor, 389)
  $conn = New-Object DirectoryServices.Protocols.LdapConnection($id, $cred, [DirectoryServices.Protocols.AuthType]::Negotiate)
  try {
    $conn.SessionOptions.ProtocolVersion = 3
    $conn.SessionOptions.Signing = $true
    $conn.SessionOptions.Sealing = $true
    $conn.Bind()
    $mod = New-Object DirectoryServices.Protocols.DirectoryAttributeModification
    $mod.Name = $attr
    $mod.Operation = [DirectoryServices.Protocols.DirectoryAttributeOperation]::Replace
    if ($value -is [byte[]]) { [void]$mod.Add([byte[]]$value) } else { [void]$mod.Add([string]$value) }
    [void]$conn.SendRequest((New-Object DirectoryServices.Protocols.ModifyRequest($dn, [DirectoryServices.Protocols.DirectoryAttributeModification[]]@($mod))))
  } catch {
    $m = $_.Exception.Message
    if ($m -match 'access|acceso|insufficient') { Fail "La cuenta delegada no tiene permiso para cambiar «$attr» en esta cuenta. ($m)" }
    if ($m -match 'constraint|restricci|password|contrase') { Fail "El dominio rechazó el cambio (directiva de contraseñas u otra restricción). ($m)" }
    Fail "El controlador de dominio rechazó el cambio: $m"
  } finally { $conn.Dispose() }
}

try {
  switch ($req.op) {
    'probe' { Out-Result @{ ok = $true; dominio = $base; dc = [string]$root.Properties['dnsHostName'].Value } }
    'search' {
      $q = Esc ([string]$req.q)
      $filter = switch ($req.tipo) {
        'users' { "(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=*$q*)(displayName=*$q*)(cn=*$q*)))" }
        'groups' { "(&(objectClass=group)(|(sAMAccountName=*$q*)(cn=*$q*)))" }
        'computers' { "(&(objectClass=computer)(|(sAMAccountName=*$q*)(cn=*$q*)))" }
        default { Fail 'Tipo de búsqueda no válido.' }
      }
      $s = New-Object DirectoryServices.DirectorySearcher((Entry $base), $filter)
      $s.SizeLimit = 50
      foreach ($n in 'sAMAccountName', 'cn', 'displayName', 'distinguishedName', 'userAccountControl', 'lockoutTime', 'operatingSystem') { [void]$s.PropertiesToLoad.Add($n) }
      $items = foreach ($r in $s.FindAll()) {
        $p = $r.Properties
        $uac = if ($p['useraccountcontrol'].Count) { [int]$p['useraccountcontrol'][0] } else { $null }
        [ordered]@{ sam = [string]$p['samaccountname'][0]; name = [string]$(if ($p['displayname'].Count) { $p['displayname'][0] } else { $p['cn'][0] })
          dn = [string]$p['distinguishedname'][0]; kind = $(switch ($req.tipo) { 'users' { 'user' } 'groups' { 'group' } default { 'computer' } })
          enabled = $(if ($null -ne $uac) { -not ($uac -band 2) } else { $null })
          lockedHint = $(if ($p['lockouttime'].Count) { [int64]$p['lockouttime'][0] -gt 0 } else { $false })
          os = $(if ($p['operatingsystem'].Count) { [string]$p['operatingsystem'][0] } else { $null }) }
      }
      Out-Result @{ ok = $true; items = @($items) }
    }
    'get' { Out-Result @{ ok = $true; item = (Read-AdItem (Find-Dn $req.cuenta)) } }
    default {
      $dn = Find-Dn $req.cuenta
      $before = Read-AdItem $dn
      if ($before.kind -ne 'user') { Fail 'Solo se pueden modificar cuentas de usuario.' }
      if ($before.rid -in 500, 502) { Fail 'Cuenta integrada del dominio: no se modifica.' }
      switch ($req.op) {
        'unlock' { Modify $dn 'lockoutTime' '0' }
        'enable' { Modify $dn 'userAccountControl' ([string]((Get-Uac $dn) -band (-bnot 2))) }
        'disable' { Modify $dn 'userAccountControl' ([string]((Get-Uac $dn) -bor 2)) }
        'reset' {
          if ([string]$req.password -notmatch '^.{12,64}$') { Fail 'Contraseña temporal no válida.' }
          $bytes = [Text.Encoding]::Unicode.GetBytes('"' + [string]$req.password + '"')
          $req.password = $null
          Modify $dn 'unicodePwd' $bytes
          [Array]::Clear($bytes, 0, $bytes.Length)
          Modify $dn 'pwdLastSet' '0'
        }
      }
      Out-Result @{ ok = $true; item = (Read-AdItem $dn) }
    }
  }
} catch { Fail "Error al consultar Active Directory: $($_.Exception.Message)" }
