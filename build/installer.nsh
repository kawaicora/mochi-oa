; 自定义 NSIS 安装脚本（electron-builder 自动 include 或由 nsis.include 指定）
;
; 用途：自动更新走 /S 静默安装，静默安装完成后自动启动应用。
; 手动界面安装（非静默）不自动启动。
!macro customInstall
  IfSilent 0 +2
  ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
