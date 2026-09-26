<#
  Mochi OA 截图工具
  用法:
    powershell -File tools\shot.ps1                    # 截取主屏全屏 -> tools\.shot\shot-<ts>.png
    powershell -File tools\shot.ps1 -WindowTitle "Mochi"   # 截取指定标题窗口
    powershell -File tools\shot.ps1 -Out out.png       # 自定义输出路径
#>
param(
    [string]$WindowTitle = "",
    [string]$Out = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct NativeRECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class NativeWin {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out NativeRECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $Out) {
    $dir = Join-Path $PSScriptRoot ".shot"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $Out = Join-Path $dir "shot-$ts.png"
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

if ($WindowTitle) {
    $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$WindowTitle*" } | Select-Object -First 1
    if ($proc) {
        [NativeWin]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 300
        $rect = New-Object NativeRECT
        [NativeWin]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
        $bounds = New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
    } else {
        Write-Error "未找到窗口: $WindowTitle"
        exit 1
    }
}

$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "SAVED:$Out"
