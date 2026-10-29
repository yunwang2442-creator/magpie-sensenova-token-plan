#requires -Version 5.1
<#
.SYNOPSIS
  在隔离的 magpie 配置里加载本插件，不碰你日常的 plugins.json / 凭据。

.DESCRIPTION
  把 HOME / USERPROFILE / APPDATA / LOCALAPPDATA / XDG_* 指向一个临时目录，
  再跑 magpie plugin add / plugin / provider models。默认保留沙箱目录方便检查；
  -Clean 会删除它。

.EXAMPLE
  pwsh -File scripts/try.ps1
  pwsh -File scripts/try.ps1 -Clean
#>
param(
  [string]$PluginPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Magpie = "magpie",
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$realProfile = $env:USERPROFILE
$sandbox = Join-Path $env:TEMP ("magpie-sensenova-sandbox-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$dirs = @(
  $sandbox,
  (Join-Path $sandbox "AppData\Roaming"),
  (Join-Path $sandbox "AppData\Local"),
  (Join-Path $sandbox ".config"),
  (Join-Path $sandbox ".cache"),
  (Join-Path $sandbox ".local\share"),
  (Join-Path $sandbox ".local\state")
)
foreach ($dir in $dirs) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$vars = @{
  HOME              = $sandbox
  USERPROFILE       = $sandbox
  APPDATA           = (Join-Path $sandbox "AppData\Roaming")
  LOCALAPPDATA      = (Join-Path $sandbox "AppData\Local")
  XDG_CONFIG_HOME   = (Join-Path $sandbox ".config")
  XDG_CACHE_HOME    = (Join-Path $sandbox ".cache")
  XDG_DATA_HOME     = (Join-Path $sandbox ".local\share")
  XDG_STATE_HOME    = (Join-Path $sandbox ".local\state")
  MAGPIE_ADDR       = "127.0.0.1:3499"
}
# 复用已下载的 Bun，沙箱只隔离配置，不重新下载；取缓存里最新的版本。
$bun = $null
$bunRoot = Join-Path $realProfile ".cache\magpie\bun"
if (Test-Path $bunRoot) {
  $bun = Get-ChildItem $bunRoot -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "magpie-bun.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
if ($bun) { $vars["MAGPIE_BUN"] = $bun }
$old = @{}
foreach ($name in $vars.Keys) {
  $old[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  [Environment]::SetEnvironmentVariable($name, $vars[$name], "Process")
}

try {
  Write-Host "sandbox: $sandbox"
  Write-Host "plugin : $PluginPath"
  Write-Host ""
  & $Magpie plugin add $PluginPath
  if ($LASTEXITCODE -ne 0) { throw "magpie plugin add 失败（exit $LASTEXITCODE）" }
  Write-Host ""
  & $Magpie plugin
  if ($LASTEXITCODE -ne 0) { throw "magpie plugin 失败（exit $LASTEXITCODE）" }
  Write-Host ""
  Write-Host "提示：沙箱没有登录，provider models 不会列出账号；上面的 7 models 已证明插件加载成功。"
} finally {
  foreach ($name in $old.Keys) {
    [Environment]::SetEnvironmentVariable($name, $old[$name], "Process")
  }
  if ($Clean) { Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
  else { Write-Host ""; Write-Host "沙箱保留在：$sandbox" }
}
