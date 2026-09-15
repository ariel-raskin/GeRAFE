; Keep an existing taskbar pin from GeRAFE's pre-installer development setup
; working through the one-time transition to the NSIS-managed installation.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$LOCALAPPDATA\Programs\GeRAFE\${MAINBINARYNAME}.exe" 0 gerafe_legacy_copy_done
  CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe" "$LOCALAPPDATA\Programs\GeRAFE\${MAINBINARYNAME}.exe"
  gerafe_legacy_copy_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$LOCALAPPDATA\Programs\GeRAFE\${MAINBINARYNAME}.exe"
  RMDir "$LOCALAPPDATA\Programs\GeRAFE"
!macroend
