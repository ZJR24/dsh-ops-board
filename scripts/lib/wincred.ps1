# 读取 Windows 凭据管理器里的 GitHub token。
# target: "GitHub - https://api.github.com/ZJR24"（用户名 ZJR24，Persist=3 企业级持久）
#
# 用法（dot-source 后调用）：
#   . .\wincred.ps1
#   $tok = Get-GitHubToken
#
# ⚠️ 两个坑（都踩过）：
#   ① C# 源码必须整体放进 Add-Type -TypeDefinition 的字符串里，
#      直接写在 .ps1 顶层会被 PowerShell 当命令解析（报 "Missing using directive"）。
#   ② 凭据 blob 是 UTF-8/ASCII 字节，**不是 UTF-16**。
#      用 Marshal.PtrToStringUni 读出来是乱码（长度还正好减半），
#      拿去请求 API 会报 "Request headers must contain only ASCII characters"。

$ErrorActionPreference = 'Stop'

if (-not ('WinCred' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);

  public static string Token(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) return "";
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return Encoding.UTF8.GetString(b).TrimEnd('\0');
    } finally {
      CredFree(p);
    }
  }
}
'@
}

function Get-GitHubToken {
  param(
    [string]$Target = 'GitHub - https://api.github.com/ZJR24',
    [string]$FallbackUser = 'ZJR24'
  )
  $tok = [WinCred]::Token($Target)
  if ($tok) { return $tok }
  # 兜底：不同版本 gh / Git Credential Manager 写的 target 名字不完全一样，
  # 按用户名再找一次，别因为一个字符串对不上就说「没有凭据」。
  $all = cmdkey /list | Select-String -Pattern ('GitHub.*' + [regex]::Escape($FallbackUser))
  foreach ($m in $all) {
    if ($m.Line -match 'Target:\s*(\S.*?)\s*$') {
      $t = $Matches[1].Trim()
      $try = [WinCred]::Token($t)
      if ($try) { return $try }
    }
  }
  return $null
}
