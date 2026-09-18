param(
    [Parameter(Mandatory = $true)]
    [string]$Wrapper,

    [Parameter(Mandatory = $true)]
    [string]$Arguments
)

$repoRoot = Split-Path -Parent (Split-Path -Parent $Wrapper)
$commandLine = "/d /c call `"$Wrapper`" $Arguments"
$cmdPath = Join-Path $env:WINDIR "System32\cmd.exe"

try {
    $child = Start-Process `
        -FilePath $cmdPath `
        -ArgumentList $commandLine `
        -WorkingDirectory $repoRoot `
        -Verb RunAs `
        -Wait `
        -PassThru `
        -ErrorAction Stop

    exit $child.ExitCode
}
catch {
    Write-Error "无法以管理员权限启动 Tauri：$($_.Exception.Message)"
    exit 1
}
