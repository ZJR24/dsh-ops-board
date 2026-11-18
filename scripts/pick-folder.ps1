param([string]$Start = "", [switch]$DryRun)

$ErrorActionPreference = 'Stop'

# 输出统一走 UTF-8。
# Windows PowerShell 5.1 默认按控制台代码页（本机是 GBK）输出，
# 而 Node 那边按 UTF-8 解码 stdout，中文就会变成乱码。
# 这一行不加，对话框标题和选出来的中文路径都会是问号方块。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$TITLE = '选择报表保存到哪个文件夹'

# -DryRun：只把标题打出来，用来检查这个文件的中文有没有被正确解码。
# Windows PowerShell 5.1 读无 BOM 的 .ps1 时按 GBK 解释，
# 中文字面量会变成乱码 —— 所以本文件必须存成「UTF-8 带 BOM」。
if ($DryRun) {
  [Console]::Out.Write($TITLE)
  exit 0
}

$shell = New-Object -ComObject Shell.Application

$flags = 0
$flags = $flags -bor 0x00000001   # BIF_RETURNONLYFSDIRS：只能选文件夹，不列文件
$flags = $flags -bor 0x00000040   # BIF_NEWDIALOGSTYLE：可缩放、带「新建文件夹」
$flags = $flags -bor 0x00000010   # BIF_EDITBOX：可直接粘路径

try {
  $folder = $shell.BrowseForFolder(0, $TITLE, $flags, $Start)
  if ($null -ne $folder) {
    [Console]::Out.Write($folder.Self.Path)
  }
} finally {
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}
