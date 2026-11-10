; 自定义 NSIS 安装脚本（electron-builder 自动 include 或由 nsis.include 指定）
;
; 用途：自动更新走 /S 静默安装，静默安装完成后自动启动应用。
; 手动界面安装（非静默）不自动启动。

; 安装前杀死正在运行的旧进程（自动更新时 app.quit 有概率残留进程）
!macro customInit
  ; 杀死所有正在运行的应用进程（包括 GPU/辅助进程）
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
  ; 等待进程退出
  Sleep 1000
!macroend

!macro customInstall
  IfSilent 0 +2
  ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
