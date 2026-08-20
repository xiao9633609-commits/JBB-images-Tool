!macro customInstall
  DetailPrint "Configuring Windows sandbox permissions..."
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /C /Q'
  Pop $0
  Pop $1
  DetailPrint "Windows sandbox permission result: $0"
!macroend
